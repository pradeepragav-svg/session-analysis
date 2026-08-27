# Session Length Investigation — Consolidated Report

**Enterprise ID:** `d96d0adf-4b0d-4458-9c13-9146ec6a35f1`
**Date range analyzed:** Primarily June 29, 2026 (single-day scope, partition-pruned for query performance)
**Tables:** `wfx_olap2.session_raw_events`, `wfx_olap2.events`, `wfx_olap2.session_replay_metadata`
**Status:** In progress — a critical data-integrity question (join-key validity) is open and must be resolved before the headline finding can be trusted.

---

## 1. Objective

Session replay recordings are running far longer than expected, inflating storage cost. The client-side idle timer (30 min) resets on every rrweb event and on every periodic full snapshot (fired every 5 minutes regardless of activity). The investigation set out to determine which of three mechanisms is driving long sessions:

- **H1 — Periodic FullSnapshot**: the 5-minute timer-driven snapshot alone keeps resetting the idle clock on an otherwise-abandoned tab.
- **H2 — Analytics SDK noise**: Whatfix analytics events (DOM mutations, beacons) reset the idle timer independent of genuine user activity.
- **H3 — Genuine extended engagement**: long sessions reflect real, sustained product usage (end users or internal builder/QA accounts), not idle keepalive.

---

## 2. Baseline — Original Session Duration Distribution

Supplied at the start of this investigation, derived from `session_replay_metadata` and `session_raw_events` (full history, not date-scoped):

| Duration | `session_replay_metadata` | % | `session_raw_events` | % |
|---|---|---|---|---|
| 0–30s | 76,812 | 17.00% | 22,683 | 18.56% |
| 30–60s | 31,861 | 7.05% | 8,484 | 6.94% |
| 1–2 min | 35,885 | 7.94% | 9,727 | 7.96% |
| 2–5 min | 51,176 | 11.32% | 13,353 | 10.92% |
| 5–10 min | 41,403 | 9.16% | 10,889 | 8.91% |
| 10–30 min | 63,580 | 14.07% | 16,572 | 13.56% |
| **30 min+** | **151,235** | **33.46%** | **40,538** | **33.16%** |
| **Total** | **451,952** | | **122,246** | |

Key takeaway at baseline: **33% of all sessions exceed 30 minutes**, and `session_raw_events` covers only ~27% of total sessions (the rest have migrated to blob storage). The two tables' proportional distributions agreed within ~0.5%, validating data consistency between them.

---

## 3. Phase 1 — Gap Analysis (broken query, root-caused)

**Goal:** measure the max gap between consecutive events per session, to test whether long sessions never get a quiet window (consistent with H1/H2).

**Result:** every `avg_max_gap_s` value returned ≈1.78 billion seconds — the Unix timestamp of "now," not a real gap.

| bucket | sessions | avg_max_gap_s | pct_5min_pattern |
|---|---|---|---|
| 0–30min | 81,709 | 1,781,992,845 | 0.0% |
| 30–60min | 11,597 | 1,781,984,304 | 0.0% |
| 1–2hr | 10,736 | 1,781,978,384 | 0.0% |
| 2–4hr | 8,302 | 1,781,981,179 | 0.0% |
| 4–8hr | 5,698 | 1,781,981,881 | 0.0% |
| 8hr+ | 4,205 | 1,781,954,770 | 0.0% |

**Root cause:** `lagInFrame()` on a non-nullable `DateTime` column returns `toDateTime(0)` (Unix epoch, 1970-01-01) for the first row in each session partition — not `NULL`. The filter `gap_s > 0` didn't catch this because `dateDiff(epoch, 2026-event-time)` is a large positive number, not a sentinel. Every session therefore had one fabricated ~56-year gap, swamping every aggregate.

**Fix identified (not yet re-run):** add `row_number() OVER (...) AS rn` and filter `WHERE rn > 1` before computing gaps.

This phase is superseded by the `event_type`-based analysis in Section 6, which avoids the gap-calculation approach entirely. The corrected gap query was written but not re-executed, since the schema discovery in Section 5 provided a more direct and reliable path to event classification.

---

## 4. Phase 2 — Event Density Analysis (valid)

**Goal:** events-per-minute by duration bucket, as a quick proxy for "is this session driven by a sparse 5-min snapshot timer, or something firing constantly?"

| bucket | sessions | avg_events | avg_events/min | p50_events/min | pct_near_snapshot_floor |
|---|---|---|---|---|---|
| 0–30min | 80,526 | 600 | 166.48 | 105.31 | 0.0% |
| 30–60min | 11,597 | 1,542 | 36.20 | 19.44 | 0.2% |
| 1–2hr | 10,736 | 2,141 | 25.17 | 13.29 | 1.1% |
| 2–4hr | 8,302 | 3,661 | 21.59 | 12.40 | 2.1% |
| 4–8hr | 5,698 | 6,842 | 20.03 | 12.01 | 4.2% |
| 8hr+ | 4,205 | 9,835 | 15.90 | **6.91** | 14.4% |

**Finding:** the snapshot-only floor is ~0.2 events/min (one event every 5 minutes). Actual median density in 8hr+ sessions is **6.91 events/min** — roughly **35× above the floor**. Only 14.4% of 8hr+ sessions are anywhere near the snapshot-only pattern. This was the first signal that **H1 (periodic snapshot alone) is not the dominant driver** — something is generating events every 5–9 seconds in long sessions.

---

## 5. Schema Discovery

### 5.1 `session_raw_events`

```sql
CREATE TABLE wfx_olap2.session_raw_events
(
    `ent_id` UUID,
    `session_id` UUID,
    `user_id` UUID,
    `created_at` DateTime64(3, 'UTC') CODEC(Delta(8), LZ4),
    `sequence_num` UInt32,
    `hit_id` UUID,
    `event_type` UInt8,
    `page_url` String CODEC(LZ4),
    `properties` Map(String, String) CODEC(LZ4),
    `ingest_time` DateTime DEFAULT now() CODEC(Delta(8), LZ4),
    `event_payload` String CODEC(LZ4),
    `event_payload_version` UInt8 DEFAULT 0 CODEC(LZ4)
)
ENGINE = ReplicatedMergeTree(...)
PARTITION BY toDate(created_at)
PRIMARY KEY (ent_id, user_id, session_id, created_at)
ORDER BY (ent_id, user_id, session_id, created_at, sequence_num)
TTL toDateTime(created_at) + toIntervalMonth(1)
```

`event_type` is a first-class `UInt8` column — no payload decoding needed for rrweb event-type classification. `PARTITION BY toDate(created_at)` is why all subsequent queries scope to specific dates (partition pruning avoids full-month scans and query timeouts).

### 5.2 `events` (analytics)

```sql
CREATE TABLE wfx_olap2.events
(
    `hit_id` String,
    `created_at` DateTime64(3, 'UTC') CODEC(Delta(8), LZ4),
    `ent_id` UUID,
    `type` String,
    `source` LowCardinality(String) DEFAULT 'web',
    `category` LowCardinality(String) DEFAULT '-',
    `user_id` UUID,
    `event_version` UInt8,
    `geo_country` String,
    `properties` Map(String, String),
    `pii_properties` Map(String, String),
    `numeric_properties` Map(String, Int64),
    `measures` Map(String, Int64),
    `segment_name` String ALIAS properties['segment_name'],
    `segment_id` UUID ALIAS toUUIDOrZero(properties['segment_id']),
    `src_id` LowCardinality(String) MATERIALIZED properties['src_id'],
    `hostname` String MATERIALIZED domain(properties['on_id']),
    ...
    `wfx_usr_session_id` Nullable(UUID) MATERIALIZED if(empty(properties['wfx_usr_session_id']), NULL, reinterpretAsUUID(sipHash128(properties['wfx_usr_session_id']))),
    `pii_resolved_user` String
)
ENGINE = ReplicatedReplacingMergeTree(...)
PARTITION BY toYYYYMMDD(created_at)
TTL multiIf(type IN ('SELF_HELP_LOADED','SMART_TIP_LOADED'), ... + toIntervalMonth(3), ... + toIntervalMonth(13))
```

`wfx_usr_session_id` is a `MATERIALIZED` column — `sipHash128()` of the raw session string from `properties`. This is the column production code joins against `session_raw_events.session_id` (confirmed via the production `session_replay_listing` query, see Section 7).

---

## 6. Phase 3 — Event Type Distribution (valid, `event_type` column)

```sql
SELECT
    multiIf(d.duration_s < 1800,'0-30min', d.duration_s < 3600,'30-60min',
            d.duration_s < 7200,'1-2hr', d.duration_s < 14400,'2-4hr',
            d.duration_s < 28800,'4-8hr','8hr+') AS bucket,
    count() AS total_events,
    round(countIf(event_type = 2) * 100.0 / count(), 1)  AS pct_full_snapshot,
    round(countIf(event_type = 3) * 100.0 / count(), 1)  AS pct_incremental,
    round(countIf(event_type = 5) * 100.0 / count(), 1)  AS pct_custom,
    round(countIf(event_type = 4) * 100.0 / count(), 1)  AS pct_meta
FROM wfx_olap2.session_raw_events e
JOIN (
    SELECT session_id, dateDiff('second', min(created_at), max(created_at)) AS duration_s
    FROM wfx_olap2.session_raw_events
    WHERE ent_id = 'd96d0adf-4b0d-4458-9c13-9146ec6a35f1'
    GROUP BY session_id
) d USING (session_id)
WHERE e.ent_id = 'd96d0adf-4b0d-4458-9c13-9146ec6a35f1'
GROUP BY bucket
ORDER BY min(d.duration_s)
```

| bucket | total_events | pct_full_snapshot | pct_incremental | pct_custom | pct_meta |
|---|---|---|---|---|---|
| 0–30min | 48,286,857 | 0.4% | 99.2% | 0.0% | 0.4% |
| 30–60min | 17,887,518 | 0.4% | 99.1% | 0.0% | 0.5% |
| 1–2hr | 22,982,015 | 0.5% | 99.1% | 0.0% | 0.5% |
| 2–4hr | 30,390,953 | 0.4% | 99.1% | 0.0% | 0.4% |
| 4–8hr | 38,984,499 | 0.3% | 99.3% | 0.0% | 0.3% |
| 8hr+ | 41,356,978 | 0.4% | 99.2% | 0.0% | 0.4% |

**Findings:**
- **FullSnapshot is flat at ~0.4% across every bucket.** Its rate doesn't change with session length — it's background noise, not a session-length driver.
- **IncrementalSnapshot dominates at 99.2%**, also flat in proportion across buckets, but the absolute volume per session scales massively with duration (confirmed in Section 4).
- **Custom events (type 5) are 0.0%** across 200M+ events. Whatever analytics SDK exists, it does not embed directly into the rrweb event stream as type-5 custom events.

---

## 7. Production Query Reference — `session_replay_listing`

User supplied the production query used to list sessions in the replay UI. Key structural insight extracted from it (not independently re-run, used to validate join methodology):

- Confirms `sre.session_id` is matched directly against `events.wfx_usr_session_id` (no `toUUIDOrZero` parsing needed — the materialized column already produces a comparable UUID).
- Confirms production's own definition of "a real Whatfix interaction" for the purpose of finding sessions with replay-worthy activity: `category = 'whatfix'`, `src_id != 'site'`, `hostname NOT IN ('cdn.whatfix.com')`, plus a large explicit allowlist of ~200 `type` values (guide/flow/hub/tasklist/survey engagement events, excluding raw page-view/beacon noise).
- This allowlist was reused directly in Section 8's correlation query.

---

## 8. Phase 4 — Storage Proportionality (single day, 2026-06-29)

**Goal:** quantify whether FullSnapshot count/storage scales proportionally with session duration (a direct storage-cost risk if so).

```sql
SELECT
    multiIf(...) AS bucket,
    count(DISTINCT e.session_id) AS sessions,
    round(avgIf(length(e.event_payload), e.event_type = 2), 0) AS avg_full_snapshot_bytes,
    round(avgIf(length(e.event_payload), e.event_type = 3), 0) AS avg_incremental_bytes,
    round(sumIf(length(e.event_payload), e.event_type = 2) / 1e9, 2) AS full_snapshot_GB,
    round(sumIf(length(e.event_payload), e.event_type = 3) / 1e9, 2) AS incremental_GB,
    round(sumIf(length(e.event_payload), e.event_type = 2) * 100.0 / sum(length(e.event_payload)), 1) AS pct_storage_from_snapshots
FROM wfx_olap2.session_raw_events AS e
JOIN (...duration_s subquery...) d USING (session_id)
WHERE e.ent_id = '...' AND toDate(e.created_at) = '2026-06-29'
GROUP BY bucket ORDER BY min(d.duration_s)
```

| bucket | sessions | avg_full_snapshot_bytes | avg_incremental_bytes | full_snapshot_GB | incremental_GB | pct_storage_from_snapshots |
|---|---|---|---|---|---|---|
| 0–30min | 8,302 | 575,854 | 3,709 | 12.55 | 20.73 | 37.7% |
| 30–60min | 1,010 | 642,706 | 3,726 | 4.62 | 6.79 | 40.5% |
| 1–2hr | 907 | 644,331 | 3,726 | 6.88 | 9.01 | 43.3% |
| 2–4hr | 679 | 666,702 | 3,274 | 8.10 | 10.76 | 42.9% |
| 4–8hr | 492 | 697,284 | 2,582 | 8.76 | 11.00 | 44.3% |
| 8hr+ | 112 | 584,759 | 3,421 | 4.77 | 6.96 | 40.7% |

**Derived per-session figures:**

| bucket | snaps/session | total MB/session | growth vs 0–30min |
|---|---|---|---|
| 0–30min | 2.6 | 4.0 MB | 1.0× |
| 30–60min | 7.1 | 11.3 MB | 2.8× |
| 1–2hr | 11.8 | 17.5 MB | 4.4× |
| 2–4hr | 17.9 | 27.8 MB | 6.9× |
| 4–8hr | 25.5 | 40.2 MB | 10.0× |
| 8hr+ | 72.8 | 104.7 MB | **26.1×** |

**Finding:** despite FullSnapshot being only 0.4% of *event count*, it accounts for **~38–44% of raw payload storage** (large encoded DOM snapshots vs small incremental diffs). Snapshot count and total storage scale together almost 1:1 (27.7× vs 26.1× growth), confirming snapshot *size* stays roughly constant — storage growth is purely a function of snapshot *count*, which tracks how long the session survives.

**Caveat:** this is single-day data; the 8hr+ bucket has only 112 sessions and is noisier than the others. A session starting before midnight UTC on the 29th and continuing into the 8hr+ range would have its early portion truncated by the date filter, possibly inflating the apparent growth rate. A `corr()`/regression-slope query was proposed to get a precise "MB per additional hour" figure but has not yet been run.

---

## 9. Phase 5 — Whatfix Activity Correlation (H1/H2 vs H3) — scoped to 2026-06-29

```sql
WITH whatfix_events AS (
    SELECT wfx_usr_session_id AS session_id, created_at
    FROM wfx_olap2.events
    WHERE ent_id = '...' AND category = 'whatfix' AND src_id != 'site'
      AND hostname NOT IN ('cdn.whatfix.com')
      AND toDate32(created_at, 'America/New_York') = '2026-06-29'
      AND wfx_usr_session_id IS NOT NULL
      AND type IN (...~200-value production allowlist...)
),
rrweb_sessions AS (
    SELECT session_id, min(created_at) AS rrweb_start, max(created_at) AS rrweb_end,
           dateDiff('second', min(created_at), max(created_at)) AS duration_s,
           count() AS rrweb_event_count,
           countIf(event_type = 3) AS rrweb_incremental_count,
           countIf(event_type = 2) AS rrweb_snapshot_count
    FROM wfx_olap2.session_raw_events
    WHERE ent_id = '...' AND toDate(created_at) BETWEEN '2026-06-28' AND '2026-06-30'
    GROUP BY session_id
    HAVING duration_s >= 1800 AND toDate32(rrweb_start, 'America/New_York') = '2026-06-29'
),
wfx_agg AS (
    SELECT session_id, min(created_at) AS first_wfx_event, max(created_at) AS last_wfx_event, count() AS wfx_event_count
    FROM whatfix_events GROUP BY session_id
)
SELECT bucket, sessions, sessions_zero_wfx_events, pct_zero_wfx_events,
       avg_rrweb_outlives_wfx_s, p50_rrweb_outlives_wfx_s,
       avg_incremental_events, avg_wfx_events_per_session
FROM rrweb_sessions r LEFT JOIN wfx_agg w USING (session_id)
GROUP BY bucket ORDER BY min(r.duration_s)
```

| bucket | sessions | zero_wfx | pct_zero_wfx | avg_outlives_s | p50_outlives_s | avg_incremental | avg_wfx_events |
|---|---|---|---|---|---|---|---|
| 30–60min | 1,009 | 71 | 7.0% | 862 | 1,794 | 1,800 | 80.2 |
| 1–2hr | 903 | 41 | 4.5% | 1,513 | 1,826 | 2,692 | 126.8 |
| 2–4hr | 685 | 36 | 5.3% | 1,843 | 519 | 4,913 | 257.5 |
| 4–8hr | 494 | 15 | 3.0% | 1,578 | 77 | 8,361 | 578.4 |
| 8hr+ | 114 | 0 | **0.0%** | 2,090 | **22** | 20,859 | **1,767.9** |

**This was the pivotal finding of the investigation.** Three things this overturned:

1. **Zero-activity zombie sessions are rare, not dominant.** `pct_zero_wfx_events` drops to **0.0%** in the 8hr+ bucket — every long session had real Whatfix interaction recorded. The "abandoned tab generating background noise" story (H1/H2) explains at most a small minority.
2. **Whatfix event volume scales 22× from shortest to longest bucket** (80 → 1,768 events/session), and rrweb's incremental event count tracks it (11.6× growth, ratio narrowing from ~22:1 to ~12:1) — meaning longer sessions correlate with *more* genuine product interaction, not less.
3. **Median "rrweb outlives last wfx event" gap collapses to 22 seconds in 8hr+ sessions** — rrweb stops almost exactly when Whatfix activity stops, for the typical session. But the **mean stays ~2,000s** in every bucket, far above the median — a classic heavy-right-skew signature, meaning a subset of sessions do have an extended idle tail after the last interaction.

**Data-quality flag raised in this phase (unresolved):** in the 30–60min bucket, `avg_outlives_s` (862) is *lower* than `p50_outlives_s` (1,794) — mathematically backwards for a right-skewed metric unless some sessions have negative gap values. This was the first hint of the join-integrity problem confirmed in Section 10.

---

## 10. Phase 6 — Gap Percentile Distribution (⚠️ surfaced a critical data-integrity issue)

```sql
-- Same CTEs as Section 9, but with whatfix_events trimmed to 8 high-signal types
-- (FLOW_LIVE_STEP, FLOW_VIEW_STEP, HUB_TASK_LOADED, TASK_LIST_ENGAGED, LAUNCHER_CLICKED,
--  SELF_HELP_ENGAGED, LIVE_START, SMART_TIP_SHOW) and INNER JOIN instead of LEFT JOIN
SELECT bucket, sessions,
       min(...) AS min_gap_s,
       quantile(0.10)(...) AS p10_gap_s, quantile(0.25)(...) AS p25_gap_s,
       quantile(0.50)(...) AS p50_gap_s, quantile(0.75)(...) AS p75_gap_s,
       quantile(0.90)(...) AS p90_gap_s, quantile(0.95)(...) AS p95_gap_s,
       max(...) AS max_gap_s
FROM rrweb_sessions r INNER JOIN wfx_agg w USING (session_id)
GROUP BY bucket ORDER BY min(r.duration_s)
```

⚠️ **Note:** this query used a trimmed 8-type Whatfix allowlist instead of the full ~200-type production list used in Section 9, changing the matched cohort substantially (n=82–145 here vs n=494–1,009 in Section 9). The two result sets are **not directly comparable** — this was not flagged clearly enough when the query was modified.

| bucket | sessions | min_gap_s | p10 | p25 | p50 | p75 | p90 | p95 | max_gap_s |
|---|---|---|---|---|---|---|---|---|---|
| 30–60min | 82 | −26,422 | −1,637 | 96 | 1,027 | 1,998 | 2,709 | 3,230 | 8,505 |
| 1–2hr | 112 | −25,384 | −7,619 | 344 | 2,131 | 3,969 | 5,803 | 6,257 | 8,142 |
| 2–4hr | 134 | −23,678 | −12,282 | 168 | 2,163 | 6,380 | 9,268 | 10,167 | 14,519 |
| 4–8hr | 145 | −13,276 | −6,364 | **−2,552** | 2,538 | 9,247 | 14,976 | 17,409 | 21,293 |
| 8hr+ | 47 | −6,078 | −2,080 | 331 | 3,553 | 10,743 | 16,530 | 20,804 | 25,888 |

**Critical finding:** a substantial share of sessions (roughly 10–25%, and **25–50% in the 4–8hr bucket**) show negative gap values — meaning the matched "last Whatfix event" is timestamped *after* the last rrweb event, by **up to 7.3 hours** in the worst case (30–60min bucket, min_gap = −26,422s). This magnitude rules out simple clock skew.

**Leading hypothesis (unverified):** `wfx_usr_session_id` may be a longer-lived identifier (e.g. stored in `localStorage` with a multi-hour/multi-day lifetime) than rrweb's own session boundary (which correctly resets on a 30-minute idle timer). If so, one `wfx_usr_session_id` can span multiple distinct rrweb recordings across hours or days, and the join silently pulls in Whatfix activity from an unrelated later visit. **This would invalidate the gap-based conclusions in both Section 9 and Section 10** and needs to be resolved before the headline finding ("long sessions are H3, not H1/H2") can be trusted with confidence.

**Verification query proposed but not yet run:**

```sql
WITH bad_sessions AS (
    SELECT session_id, min(created_at) AS rrweb_start, max(created_at) AS rrweb_end
    FROM wfx_olap2.session_raw_events
    WHERE ent_id = '...' AND toDate(created_at) BETWEEN '2026-06-28' AND '2026-06-30'
    GROUP BY session_id
    HAVING dateDiff('second', rrweb_start, rrweb_end) BETWEEN 14400 AND 28800
       AND toDate32(rrweb_start, 'America/New_York') = '2026-06-29'
    LIMIT 5
)
SELECT b.session_id, b.rrweb_start, b.rrweb_end,
       e.created_at AS wfx_event_time, e.type AS wfx_type,
       dateDiff('second', b.rrweb_end, e.created_at) AS seconds_after_rrweb_end
FROM bad_sessions b
JOIN wfx_olap2.events e ON e.wfx_usr_session_id = b.session_id
WHERE e.ent_id = '...'
ORDER BY b.session_id, e.created_at
```

If Whatfix events for a flagged session cluster into two visually distinct time windows (one overlapping rrweb normally, a second hours later), that confirms ID reuse across visits — the fix would be to time-bound the join (e.g. `e.created_at BETWEEN b.rrweb_start AND b.rrweb_end + INTERVAL 30 MINUTE`) rather than matching on bare ID.

---

## 11. Phase 7 — User Concentration Check (inconclusive, structurally confounded)

```sql
SELECT bucket, sessions, count(DISTINCT user_id) AS distinct_users,
       round(count() / count(DISTINCT user_id), 1) AS sessions_per_user
FROM (...duration_s subquery, HAVING duration_s >= 1800...)
GROUP BY bucket ORDER BY min(duration_s)
```

| bucket | sessions | distinct_users | sessions_per_user |
|---|---|---|---|
| 30–60min | 1,065 | 537 | 2.0 |
| 1–2hr | 932 | 530 | 1.8 |
| 2–4hr | 707 | 496 | 1.4 |
| 4–8hr | 509 | 430 | 1.2 |
| 8hr+ | 138 | 122 | 1.1 |

This was run to test whether long sessions are concentrated in a small number of repeat builder/QA accounts (which would reframe the problem as "should we record replay for these account types" rather than "fix the idle timer"). The result — 122 distinct users for 138 sessions in the 8hr+ bucket — initially looked like evidence *against* the builder-account theory.

**However, this metric is structurally confounded**: a day only has 24 hours, so a user with one 8-hour session has little remaining time budget for a second session that same day. The downward trend in `sessions_per_user` as bucket duration increases is partly mechanical, not necessarily a real behavioral signal. **This phase did not produce a reliable conclusion** — a cross-day query (does the same user show long sessions repeatedly across multiple separate days?) was proposed but not yet run.

---

## 12. Summary of Findings So Far

| # | Finding | Confidence |
|---|---|---|
| 1 | The periodic 5-min FullSnapshot is flat at ~0.4% of events across all duration buckets — not a session-length driver by itself | High |
| 2 | FullSnapshot accounts for ~38–44% of raw storage despite being 0.4% of event count; snapshot count and storage scale ~26–28× from shortest to longest session bucket | High (single-day sample, methodology sound) |
| 3 | No analytics events appear as rrweb Custom (type 5) events — 0.0% across 200M+ events | High |
| 4 | 99%+ of zero-activity ("zombie") sessions disappear by the 8hr+ bucket — H1/H2 "idle tab with no real activity" explains only a small minority of long sessions | **Medium — pending Section 10 verification** |
| 5 | Whatfix event volume scales 22× and tracks rrweb incremental volume closely as sessions get longer — suggests genuine sustained engagement is the dominant pattern | **Medium — pending Section 10 verification** |
| 6 | A meaningful fraction of sessions (10–50% depending on bucket) show Whatfix events timestamped hours after the matched rrweb session ends — likely a join-key/ID-lifetime mismatch, not a real behavioral signal | **Confirmed as an open problem, root cause not yet confirmed** |
| 7 | Long sessions are not obviously concentrated in a handful of repeat users, but this metric is structurally confounded and inconclusive | Low |

**Bottom line:** the investigation surfaced a genuinely different picture than the initial hypothesis (idle-timer keepalive from periodic snapshots/analytics noise) — pointing instead toward sustained real engagement as the dominant driver of long sessions. But that conclusion currently rests on a join (`session_raw_events.session_id = events.wfx_usr_session_id`) that shows symptoms of being unreliable for sessions separated by hours. **The next required step is the Section 10 verification query** before this finding should be presented as settled.

---

## 13. Open Next Steps

1. Run the Section 10 verification query (5-session spot check) to confirm or rule out the ID-lifetime mismatch theory.
2. If confirmed, re-run Sections 9 and 10 with a time-bounded join condition and compare corrected results against what's reported here.
3. Run the proposed `corr()`/regression-slope query from Section 8 to get a precise "MB of FullSnapshot storage per additional hour of session length" figure for the storage-cost business case.
4. Re-run the corrected Phase 1 gap query (`rn > 1` filter) if a finer-grained inter-event gap analysis is still wanted alongside the `event_type`-based approach.
5. If the join-key issue is confirmed, consider a cross-day user-level query to properly test the builder/QA-account hypothesis from Section 11, since the single-day metric was inconclusive.
