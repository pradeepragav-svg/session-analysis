"""Decode rrweb event_payload (base64 + zlib-compressed JSON, confirmed against
viewer/src/services/decoder.ts) into a flat, semantically-meaningful record per
event -- top_type/is_user_driven plus per-event-type metadata (which DOM
node(s) a Mutation touched, what kind of change it was, which node a
MouseInteraction/Scroll/Input targeted) -- so sessions can be analyzed without
manually re-decoding payloads. Purely per-event/stateless: no cross-event DOM
reconstruction, just what's already present in each event's own payload.
"""
import base64
import json
import zlib

RRWEB_EVENT_TYPES = {
    0: "DomContentLoaded",
    1: "Load",
    2: "Snapshot",
    3: None,  # IncrementalSnapshot -- resolved via data.source below
    4: "Meta",
    5: "Custom",
    6: "Plugin",
}

INCREMENTAL_SOURCES = {
    0: "Mutation",
    1: "MouseMove",
    2: "MouseInteraction",
    3: "Scroll",
    4: "ViewportResize",
    5: "Input",
    6: "TouchMove",
    7: "MediaInteraction",
    8: "StyleSheetRule",
    9: "CanvasMutation",
    10: "Font",
    11: "Log",
    12: "Drag",
    13: "StyleDeclaration",
    14: "Selection",
    15: "AdoptedStyleSheet",
    16: "CustomElement",
}

USER_DRIVEN_SOURCES = {1, 2, 3, 5, 6}  # MouseMove, MouseInteraction, Scroll, Input, TouchMove

MOUSE_INTERACTIONS = {
    0: "MouseUp", 1: "MouseDown", 2: "Click", 3: "ContextMenu", 4: "DblClick",
    5: "Focus", 6: "Blur", 7: "TouchStart", 9: "TouchEnd", 10: "TouchCancel",
}

EMPTY_METADATA = {
    "mutation_node_ids": [], "mutation_text_count": 0, "mutation_attr_count": 0,
    "mutation_add_count": 0, "mutation_remove_count": 0,
    "interaction_subtype": "", "target_node_id": None,
}


def decode_payload(event_payload: str):
    """Returns the parsed rrweb event dict, or None if decode/parse fails."""
    try:
        raw = base64.b64decode(event_payload)
    except Exception:
        return None
    try:
        return json.loads(zlib.decompress(raw))
    except Exception:
        try:
            return json.loads(raw)
        except Exception:
            return None


def _mutation_metadata(data: dict) -> dict:
    texts = data.get("texts") or []
    attrs = data.get("attributes") or []
    adds = data.get("adds") or []
    removes = data.get("removes") or []
    node_ids = (
        [t.get("id") for t in texts]
        + [a.get("id") for a in attrs]
        + [a.get("node", {}).get("id") for a in adds]
        + [r.get("id") for r in removes]
    )
    return {
        **EMPTY_METADATA,
        "mutation_node_ids": [n for n in node_ids if n is not None],
        "mutation_text_count": len(texts),
        "mutation_attr_count": len(attrs),
        "mutation_add_count": len(adds),
        "mutation_remove_count": len(removes),
    }


def describe_event(event_type: int, event_payload: str) -> dict:
    """Returns {top_type, is_user_driven, **metadata} for one session_raw_events row."""
    if event_type != 3:
        return {
            "top_type": RRWEB_EVENT_TYPES.get(event_type, f"Type{event_type}"),
            "is_user_driven": 0,
            **EMPTY_METADATA,
        }

    decoded = decode_payload(event_payload)
    data = (decoded.get("data") or {}) if decoded is not None else {}
    source = data.get("source")
    if source is None:
        return {"top_type": "Other", "is_user_driven": 0, **EMPTY_METADATA}

    top_type = INCREMENTAL_SOURCES.get(source, f"Source{source}")
    is_user_driven = int(source in USER_DRIVEN_SOURCES)

    if source == 0:  # Mutation
        return {"top_type": top_type, "is_user_driven": is_user_driven, **_mutation_metadata(data)}
    if source == 2:  # MouseInteraction
        return {
            "top_type": top_type, "is_user_driven": is_user_driven, **EMPTY_METADATA,
            "interaction_subtype": MOUSE_INTERACTIONS.get(data.get("type"), ""),
            "target_node_id": data.get("id"),
        }
    if source in (3, 5):  # Scroll, Input
        return {
            "top_type": top_type, "is_user_driven": is_user_driven, **EMPTY_METADATA,
            "target_node_id": data.get("id"),
        }
    return {"top_type": top_type, "is_user_driven": is_user_driven, **EMPTY_METADATA}


def classify(event_type: int, event_payload: str):
    """Back-compat thin wrapper: returns (top_type, is_user_driven)."""
    d = describe_event(event_type, event_payload)
    return d["top_type"], d["is_user_driven"]


# rrweb-snapshot node types (from rrweb's NodeType enum): 0=Document,
# 1=DocumentType, 2=Element, 3=Text, 4=CDATA, 5=Comment.
_ELEMENT_NODE = 2
_TEXT_NODE = 3


def _walk_snapshot_tree(node, parent_tag, parent_attrs, out):
    """Recursively flatten a FullSnapshot's serialized DOM tree into one
    descriptor per node id. A text node's descriptor is described via its
    PARENT element's tag/class/id, since the text node itself carries no
    tag -- e.g. node 842 (a text node) describes as tag=span via its parent,
    with its own text as a snapshot-time-only sample (mutations change it
    later; this is just what it looked like when this snapshot was taken).
    """
    node_type = node.get("type")
    node_id = node.get("id")

    if node_type == _ELEMENT_NODE:
        tag = node.get("tagName", "")
        attrs = node.get("attributes") or {}
        if node_id is not None:
            out.append({
                "node_id": node_id, "tag_name": tag,
                "class_attr": attrs.get("class", ""), "id_attr": attrs.get("id", ""),
                "text_snippet": "",
            })
        for child in node.get("childNodes") or []:
            _walk_snapshot_tree(child, tag, attrs, out)
    elif node_type == _TEXT_NODE:
        if node_id is not None:
            out.append({
                "node_id": node_id, "tag_name": parent_tag or "",
                "class_attr": (parent_attrs or {}).get("class", ""),
                "id_attr": (parent_attrs or {}).get("id", ""),
                "text_snippet": (node.get("textContent") or "")[:200],
            })
    else:
        for child in node.get("childNodes") or []:
            _walk_snapshot_tree(child, parent_tag, parent_attrs, out)


def extract_node_descriptors(event_payload: str):
    """For a FullSnapshot (event_type=2) payload, returns a flat list of
    {node_id, tag_name, class_attr, id_attr, text_snippet} -- one per element
    and text node in the snapshot's serialized DOM tree. Used to resolve the
    opaque node ids referenced by later Mutation/MouseInteraction/etc. events
    to real elements, rebuilt once per FullSnapshot rather than via continuous
    stateful mutation replay (see staged_narrative_summarization_design doc).
    """
    decoded = decode_payload(event_payload)
    if decoded is None:
        return []
    root = (decoded.get("data") or {}).get("node")
    if root is None:
        return []
    out = []
    _walk_snapshot_tree(root, None, None, out)
    return out
