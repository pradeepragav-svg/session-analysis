# Design: Staged (map-reduce) summarization of `session_event_narrative`

**Date:** 2026-07-03
**Builds on:** `rrweb_periodic_snapshot_finding_2026-07-02.md`, `session_event_narrative` (in `analysis/sql/06_event_narrative.sql`)

---

## 1. Problem

`session_event_narrative` gives a clean, chronological, human-readable line per event -- but a long session can be thousands of rows (`f1cc7808` was 4,243 rows over 8.7hrs; the session we skipped earlier had 145,332 rows). Handing the *entire* narrative to one LLM call doesn't scale: cost grows with session length, and a single pass over tens of thousands of lines is both expensive and less reliable than a focused read of a smaller slice.

The fix is the standard map-reduce/hierarchical-summarization pattern: split the narrative into bounded-size stages, summarize each stage independently (small, cheap, parallelizable), then synthesize across just the stage summaries (a handful of short paragraphs, not thousands of rows) to get the session-level verdict.

---

## 2. Three tiers

```
Tier 0: session_event_narrative        (existing -- one row per event)
              │  SQL: segment into stages
              ▼
Tier 1: stage boundaries                (SQL, deterministic, cheap)
              │  fan out, one agent per stage (parallel)
              ▼
Tier 2: per-stage summary                (LLM "map" step)
              │  one agent, reads only the stage summaries
              ▼
Tier 3: session-level synthesis          (LLM "reduce" step)
```

### Tier 1 -- stage boundaries (SQL)

Two ways to define a stage boundary, and they should probably both be used together:

1. **Activity-gap boundary** -- start a new stage whenever there's a gap `> N minutes` since the previous event (reuse the same gaps-and-islands pattern already used for `session_inactivity_intervals`). This naturally separates "the 6-hour LIST dwell" from "the 90-second record-page burst" into distinct stages, rather than slicing at an arbitrary clock boundary that could cut a real burst in half.
2. **`page_url` change boundary** -- start a new stage whenever `page_url` changes, since a page navigation is a natural semantic break (confirmed valuable in the `f1cc7808` analysis: the whole session naturally decomposed into 7 page-visits).

Sketch:

```sql
CREATE VIEW session_narrative_stages AS
SELECT
    session_id,
    ts,
    page_url,
    event_description,
    sum(new_stage) OVER (PARTITION BY session_id ORDER BY ts) AS stage_id
FROM (
    SELECT
        session_id, ts, page_url, event_description,
        if(
            ms_since_prev_event IS NULL
            OR ms_since_prev_event > 180000  -- 3 min gap
            OR page_url != lagInFrame(page_url) OVER (PARTITION BY session_id ORDER BY ts),
            1, 0
        ) AS new_stage
    FROM session_event_narrative
)
```

This bounds each stage's row count naturally (a stage ends at every real break), and the total number of stages is small regardless of the session's total event count -- a 145k-event session with long idle stretches would still collapse into a manageable number of stages, since most of those 145k rows are presumably repetitive background noise within a few long stages, not 145k independent bursts.

### Tier 2 -- per-stage summary (LLM map step)

For each `stage_id`, hand its raw narrative rows (bounded size, since a stage is capped by the boundary rule above) to an agent with a fixed, compact output schema:

```json
{
  "stage_id": 3,
  "start_ts": "...", "end_ts": "...", "duration_s": ...,
  "page_url": "...",
  "event_count": ...,
  "real_activity": true/false,
  "activity_density_per_min": ...,
  "notable_patterns": ["node 842 ticks every ~60s, text-only", "..."],
  "one_line_summary": "User opened project record G0b and filled a form (54 events, high density)."
}
```

Structured output (via a JSON schema) keeps Tier 3's input compact and consistent -- this is the same `schema` pattern the `Workflow` tool's `agent()` call supports natively (forces a `StructuredOutput` call instead of prose), so this maps directly onto a `pipeline()` of stage-summarizer agents if/when this is run as an actual `Workflow`.

### Tier 3 -- synthesis (LLM reduce step)

One final agent reads only the array of Tier-2 summaries (a handful of small JSON objects, not the raw narrative) and produces the session-level verdict: engagement %, notable anomalies, overall story -- exactly the kind of report the subagent produced manually for `f1cc7808` and `page_url`-enriched analysis earlier, but now reproducible at any session size without truncating or guessing.

---

## 3. Why this scales

- **Bounded per-agent context.** Every Tier-2 agent only ever sees one stage's rows, not the whole session -- cost per agent stays roughly constant regardless of total session length; only the *number* of stages grows (and stages are capped naturally by activity/page breaks, not by raw event count).
- **Parallelizable.** All Tier-2 stage summaries are independent of each other -- they can run concurrently (`pipeline()`/`parallel()` in the `Workflow` tool), so wall-clock time doesn't scale linearly with session length either.
- **Reusable stage-summary schema.** The same Tier-2 output could double as a durable table (`session_stage_summary`), giving a cheap mid-granularity view between `session_interval_summary` (one row, too coarse) and `session_event_narrative` (thousands of rows, too fine) -- e.g. for the viewer's `EventTimeline.tsx` to render stage-level annotations without needing full per-event detail.

---

## 4. Complementary finding: enriching stages with `FullSnapshot` data

While investigating this, decoded a real `FullSnapshot` payload (`event_type=2`) for `f1cc7808`. Structure:

```json
{
  "type": 2,
  "data": {
    "node": { "type": 0, "childNodes": [ ... recursive serialized DOM tree ... ] },
    "initialOffset": { "left": ..., "top": ... }
  },
  "timestamp": ...
}
```

Each node in the tree carries a stable `id` (the same id referenced later by Mutations/MouseInteraction/etc.), plus for element nodes: `tagName`, `attributes` (including `class`, `id` attribute, `style`), and for text nodes: `textContent`. For `f1cc7808`'s first snapshot, the `<title>` text content was **`"Home | Salesforce"`** -- a cheap, free corroboration of `page_url`.

**Two concrete extraction opportunities, much cheaper than full sequential mutation-replay:**

1. **Page title per snapshot** -- trivial: walk the tree once for the `<title>` node's `textContent`. Gives a human-readable page name alongside `page_url` for every FullSnapshot, virtually free.
2. **A node-id → element descriptor map, rebuilt once per FullSnapshot** (not continuously maintained via mutation replay). Since a FullSnapshot happens roughly every 5 minutes (or on page load), building this map once per snapshot and using it to resolve any node id referenced *until the next snapshot* is far cheaper than the full stateful DOM-reconstruction approach discussed earlier -- accept that a node created purely by a Mutation *between* two snapshots won't resolve until the next snapshot captures it (a bounded staleness window, not an unbounded one). This would directly upgrade lines like `"Text content changed on node(s) [842]"` into `"Text content changed on <span class='last-synced-label'> (842)"` -- exactly the kind of detail that would have made the original ticker investigation immediate instead of requiring a manual payload dig.

This node-map extraction is a natural fit for Tier 1/2 above: attach the nearest-preceding FullSnapshot's node descriptors to each stage before summarization, so the Tier-2 agent (or a human) gets real element context, not just opaque node ids.

---

## 5. Related fixes made while investigating this

- **`CustomElement` (`IncrementalSource` value 16) is not a Mutation** -- it fires when the page calls `customElements.define(...)` to register a native Web Component, so rrweb's replayer can re-register it before rendering. Confirmed via `~/Documents/rrweb/packages/types/src/index.ts:139-141,603-607`. Already correctly kept as its own `top_type` in `rrweb_decode.py`, separate from Mutation counts.
- **Fixed a real bug**: `rrweb_decode.py`'s `INCREMENTAL_SOURCES` mapping (inherited from `viewer/src/components/EventDetail.tsx`) was missing `IncrementalSource` value **11 (`Log`)** -- it jumped from 10 (`Font`) straight to 12 (`Drag`). Any event with `source=11` was falling through to a generic `"Source11"` label instead of `"Log"`. Fixed in `rrweb_decode.py`; the same gap still exists in the viewer's own `EventDetail.tsx` and hasn't been fixed there.

## 6. Open next steps

1. Implement the Tier-1 SQL view (`session_narrative_stages`) above.
2. Prototype Tier 2/3 as a small number of sequential `Agent` calls against `f1cc7808` first (cheap validation), before committing to a full parallel `Workflow`.
3. Decide whether stage summaries get persisted as a durable table (`session_stage_summary`) or are computed on-demand per analysis request.
4. Prototype the FullSnapshot node-id → element-descriptor extraction (Section 4) and wire it into the narrative view as an optional join, to enrich both raw narrative rows and stage summaries with real element context.
