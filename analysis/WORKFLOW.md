# Session Analysis Tool — Workflow

**Last updated:** 2026-07-03
**Purpose:** derive per-session insights (idle time, Whatfix engagement, causal narrative) from `wfx_olap2.session_raw_events`/`events` in prod, without watching replays manually.

This document describes the tool as actually built, end to end. Related design/finding docs (not superseded, but narrower in scope):
- `../session-analysis-implementation-plan.md` — the original Phase 1/Phase 2 plan (Phase 1 is now done; this doc is the up-to-date description of what Phase 1 actually became).
- `../rrweb_periodic_snapshot_finding_2026-07-02.md` — a concrete investigation that motivated several of the layers below.
- `../staged_narrative_summarization_design_2026-07-03.md` — the design for the staged/map-reduce summarization layer (Tier 1 implemented; Tier 2/3 prototyped manually, not yet wired into the pipeline).

---

## 1. Architecture

```
Production ClickHouse (wfx_olap2.session_raw_events / events)
        │  read-only, via Superset SQL Lab (superset_client.py)
        ▼
pull_and_load.py  ──►  local ClickHouse (analysis/local_clickhouse, docker-compose)
        │
        │  decodes event_payload (base64+zlib) in Python -- ClickHouse has no
        │  SQL-level zlib inflate, so this MUST happen here, not in a matview
        │  (rrweb_decode.py: describe_event(), extract_node_descriptors())
        ▼
┌─────────────────────────── local ClickHouse tables ───────────────────────────┐
│ DISPOSABLE (cleaned per-session by cleanup.py):                               │
│   session_raw_events, events                                                  │
│                                                                                │
│ DURABLE (survive cleanup -- the semantic layer, re-derivable from prod at     │
│ any time but expensive to redo, so kept once extracted):                     │
│   session_event_metadata     (per-event: top_type, is_user_driven, mutation   │
│                                node ids, interaction subtype, ...)            │
│   session_node_descriptors   (per-FullSnapshot: node_id -> tag/class/text)    │
│                                                                                │
│ STATE (never cleaned, tracks progress across all of prod):                   │
│   pipeline_state, watermark                                                  │
│                                                                                │
│ OUTPUT (durable, one row per session):                                       │
│   session_interval_summary                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼  (pure SQL views, layered)
unified_events → session_max_inactivity / session_inactivity_intervals / ...
        │
        ▼
session_event_narrative → session_event_narrative_enriched (+ node descriptors)
        │
        ▼
session_narrative_stages → session_stage_summary   (Tier 1: SQL-only reduction)
        │
        ▼
[Tier 2: one LLM agent per stage]  →  [Tier 3: one LLM agent synthesizing across stages]
   (prototyped manually via the Agent tool; not yet an automated pipeline step)
```

---

## 2. Pull & load (`pull_and_load.py`, `superset_client.py`, `rrweb_decode.py`)

**`superset_client.py`** — standalone LDAP login + CSRF + paginated SQL Lab execute client (mirrors the interactive `superset-mcp` auth flow, but scriptable/unattended).

**`pull_and_load.py`** pulls three things per session, read-only against prod:
1. `session_raw_events` rows (rrweb events) — for each row, `rrweb_decode.describe_event()` decodes the compressed `event_payload` once and returns `top_type`, `is_user_driven`, plus per-type metadata (`mutation_node_ids`, `mutation_text_count`/`attr_count`/`add_count`/`remove_count`, `interaction_subtype`, `target_node_id`). For `event_type=2` (FullSnapshot) rows specifically, `rrweb_decode.extract_node_descriptors()` also walks the serialized DOM tree once, producing a flat `node_id → {tag_name, class_attr, id_attr, text_snippet}` list.
2. `events` rows (Whatfix analytics), bounded to `category='whatfix'`.
3. `discover_sessions()` — finds session_ids whose `min(created_at)` falls on a given day, gated to "closed" sessions (already in `session_replay_metadata`, or idle beyond `CLOSED_SESSION_IDLE_HOURS`), mirroring prod's own `session_replay_listing` query.

All three get inserted into local ClickHouse: `session_raw_events`, `events`, `session_node_descriptors` (the last durable, the first two disposable).

## 3. Local schema (`sql/01`–`sql/09`)

| File | Creates | Notes |
|---|---|---|
| `01_create_tables.sql` | `session_raw_events`, `events` | Local mirror of prod, minus replication/TTL clauses; extended with the decoded metadata columns above. |
| `02_basic_matviews.sql` | `unified_events`, `session_max_inactivity`, `session_inactivity_intervals`, `session_max_total_inactivity`, `session_total_inactivity_intervals`, `session_no_whatfix`, `session_mutation_ratio` | Items #1–#3 from `session-analysis.md`, plus the `max_no_event_gap_s` (true dead-air) and `mutation_to_whatfix_ratio` triage signal added later. Whatfix events are bounded to each session's own recorded `[min, max] created_at` window (a session's Whatfix "user session" ID can outlive the rrweb recording by hours — confirmed directly, not hypothetical). |
| `03_session_interval_summary.sql` | `session_interval_summary` | One row per session — the Phase 1 output table. |
| `04_pipeline_state.sql` | `pipeline_state`, `watermark` | Day-wise resumable processing state (see below). |
| `05_event_metadata_mv.sql` | `session_event_metadata` (+ MV) | Durable per-event store, auto-populated from `session_raw_events` on insert via a real `MATERIALIZED VIEW`. Survives `cleanup.py`. |
| `06_event_narrative.sql` | `session_event_narrative` | Human/LLM-readable one-line-per-event narrative (see §5). |
| `07_node_descriptors.sql` | `session_node_descriptors` | Durable node-id → element map, one row per node per FullSnapshot. |
| `08_narrative_enriched.sql` | `session_event_narrative_enriched` | Narrative + resolved element info via `ASOF JOIN` against node descriptors. |
| `09_narrative_stages.sql` | `session_narrative_stages`, `session_stage_top_node`, `session_stage_summary` | Tier 1 of the staged-summarization design (see §6). |

## 4. Pipeline orchestration (`pipeline.py`, `cleanup.py`)

Three CLI modes, all going through the same `pipeline_state` bookkeeping:

```bash
python pipeline.py --ent-id <id> --session-id <session_id>     # ad-hoc single session
python pipeline.py --ent-id <id> --date 2026-06-29              # day-wise sweep
python pipeline.py --ent-id <id> --date-range 2026-06-23:2026-06-29
python pipeline.py --ent-id <id>                                 # watermark[ent_id] + 1
python pipeline.py --ent-id <id> --date 2026-06-29 --limit 10    # bounded smoke-test
```

`run_session()`: pull → `summarize_session()` (queries the Phase-1 matviews, writes one row to `session_interval_summary`) → `cleanup.cleanup_session()` (synchronous `ALTER TABLE ... DELETE` via `mutations_sync=1` on `session_raw_events`/`events` only — `session_event_metadata`/`session_node_descriptors` are untouched, by design).

`run_date()`: discovers closed sessions for a day, skips any already `status='cleaned'` in `pipeline_state` (idempotent re-run — uses `max(status)` rather than `argMax(status, updated_at)` since the three stages are monotonic and timestamp-tie-breaking was unreliable at sub-second granularity), processes the rest, and advances `watermark` only once every discovered session for that day reaches `cleaned`.

`get_cleaned_session_ids()` normalizes UUID columns to `str` before set comparison — `clickhouse_connect` returns UUID columns as `uuid.UUID`, but session_ids from Superset's JSON are plain `str`; comparing across types silently always fails otherwise.

## 5. Narrative layer (`sql/06`, `sql/08`)

`session_event_narrative` renders each event (rrweb + Whatfix, chronologically merged) as one readable line: `(session_id, ts, page_url, ms_since_prev_event, primary_node_id, top_type, is_user_driven, event_description)`. Intent: instead of hand-coding every anomaly pattern as a SQL heuristic, hand this sequence to an LLM (or a human) and let it detect causal patterns directly.

`session_event_narrative_enriched` adds an `ASOF LEFT JOIN` against `session_node_descriptors` (nearest-*preceding* snapshot for that node id — correctly handles node-id reuse across page navigations, and accepts bounded staleness for nodes added purely by a Mutation between two snapshots), appending `[<tag class="..." id="..."> "text"]` to the description when resolvable.

Export for external use / feeding an LLM: `SELECT ... FROM session_event_narrative_enriched WHERE session_id = '...' ORDER BY ts FORMAT TSVWithNames`.

## 6. Staged summarization (`sql/09`, design doc)

Problem: a long session (`f1cc7808` = 4,243 rows over 8.7hrs; one skipped session had 145,332 events) is too much to hand an LLM in one pass. Fix: map-reduce.

**Tier 1 (SQL, implemented)** — `session_narrative_stages` tags each event with a `stage_id`, incrementing on either a >3min gap or a real `page_url` change (Whatfix events carry `page_url=''` and are explicitly excluded from triggering a page-change boundary, since otherwise every single Whatfix event would spuriously split a stage). `session_stage_summary` then collapses each stage to one row: time bounds, `page_url`, event/user-driven/Whatfix/mutation counts, `has_real_activity`, most-repeated node (`top_node_id`/`top_node_tag`/`top_node_count` — a free, SQL-only "is this a ticker" signal), and first/last event descriptions. This alone reduced `f1cc7808` from 4,243 rows to **23 stage rows** (~184x).

**Tier 2 (LLM, prototyped manually)** — one `Agent` call per substantive stage (skipping degenerate 1-2-event stub stages), each reading only that stage's exported narrative rows plus the Tier-1 stats as reference, producing a `VERDICT` / `PATTERN` / `SUMMARY`. Not yet automated into `pipeline.py` — currently done by exporting each stage's rows to a temp TSV and dispatching parallel `Agent` calls by hand.

**Tier 3 (LLM, not yet run for this session)** — one final agent synthesizing across just the Tier-2 summaries (not the raw narrative) into the session-level verdict.

**A real finding from doing this**: Tier 2's stage-18 verdict (a focused read of one 14-second record-page visit) directly contradicted an earlier whole-session-pass verdict for the same window — the whole-session pass called it "genuine data-entry," the focused stage-level read called it "bulk render/hydration misreported as Input events." This is the argument for staging: narrower focus catches things broader sweeps gloss over. Neither has been independently confirmed yet.

## 7. Key bugs found and fixed along the way (don't reintroduce these)

1. **`event_payload` is base64+zlib-compressed JSON** — confirmed against `viewer/src/services/decoder.ts`. ClickHouse has no SQL-level zlib inflate; all decoding happens in Python (`rrweb_decode.py`) at load time, never in a matview.
2. **`lagInFrame` defaults to the type's zero-value (not NULL)** for a partition's first row — caused a ~56-year fake gap in `session_max_inactivity` until guarded with `row_number() > 1`. This exact bug is independently documented as unresolved in `session_length_investigation_2026-06-30.md` Section 3 — same root cause, found independently here.
3. **Whatfix's `wfx_usr_session_id` can outlive the rrweb recording by hours** (confirmed: one session's Whatfix events spanned 3hrs while its rrweb recording lasted 5 min) — `unified_events` and the narrative's Whatfix branch both bound Whatfix events to the session's own `[min, max] created_at` window. This is a live confirmation of `session_length_investigation_2026-06-30.md` Section 10's previously-unverified hypothesis.
4. **`argMax(status, updated_at)` ties** when two `pipeline_state` stages for the same session land in the same second — fixed by using `max(status)` since the three stages are monotonic.
5. **`str` vs `uuid.UUID` mismatch** silently broke idempotent-skip and watermark-advance logic in `pipeline.py` — `clickhouse_connect` returns UUID columns as `uuid.UUID`.
6. **Unstable `discover_sessions` pagination ordering** — no `ORDER BY`, and a busy day's session count (11,962) exceeds the 10,000-row page size, so two independent paginated queries had no guaranteed stable ordering between them. Fixed with `ORDER BY session_id`.
7. **`rrweb_decode.py`'s `INCREMENTAL_SOURCES` was missing value 11 (`Log`)** — inherited from `viewer/src/components/EventDetail.tsx`, which has the same gap, unfixed there. Confirmed against `~/Documents/rrweb/packages/types/src/index.ts`.
8. **`CustomElement` (source 16) is not a Mutation** — it's `customElements.define(...)` registration, its own `IncrementalSource`. Already correctly kept separate in `rrweb_decode.py`.
9. **`checkoutEveryNms` (rrweb's periodic FullSnapshot) is reactive, not an independent timer** — confirmed against `~/Documents/rrweb/packages/rrweb/src/record/index.ts:244-252`: it only re-checks elapsed time inside the handler for an *actual* `IncrementalSnapshot` event. A truly idle page (zero DOM events) would never trigger it. This refines (not confirms) `session_length_investigation_2026-06-30.md`'s H1 hypothesis — see `rrweb_periodic_snapshot_finding_2026-07-02.md`.
10. **Re-joining `session_event_metadata`/`session_narrative_stages` intermediate results on `(session_id, ts)`** duplicates rows whenever the source has genuine duplicate timestamps (confirmed: some sessions have literal duplicate-timestamp rows in `session_raw_events`). Fixed by exposing needed columns (`top_type`, `is_user_driven`) directly from upstream views instead of re-joining on a non-unique key.
11. **Ad-hoc test scripts that call `pull_and_load.load_sessions()` directly** (bypassing `pipeline.py`) don't go through the idempotent-skip check, and `session_event_metadata`/`session_node_descriptors` don't dedupe (`MergeTree`, not `ReplacingMergeTree`) — re-pulling the same session twice without truncating first silently doubles its durable rows. Always truncate `session_event_metadata`/`session_node_descriptors`/`session_raw_events`/`events` before re-pulling the same session_id in ad-hoc investigation.

## 8. What's not built yet

- Phase 2 proper (items #4/#5 — causal Whatfix-attribution labeling pass, `attribution.py`), per the original implementation plan.
- Tier 2/3 of staged summarization aren't wired into `pipeline.py` — currently manual (export stage TSVs, dispatch `Agent` calls by hand).
- No automated resolution of the stage-18-style Tier-2/whole-session discrepancy — would need a dedicated verification pass.
- `session_stage_summary.has_real_activity` currently counts a lone Whatfix heartbeat ping (`USER_ACTION_LATCH`-style) as "real activity" — known to overcount; not yet fixed.
