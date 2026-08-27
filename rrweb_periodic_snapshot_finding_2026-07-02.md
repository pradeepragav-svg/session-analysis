# Finding: The "periodic 5-min FullSnapshot" is not an independent timer — it's a reaction to a single ticking DOM text node

**Date:** 2026-07-02
**Enterprise ID:** `d96d0adf-4b0d-4458-9c13-9146ec6a35f1`
**Session analyzed:** `f1cc7808-a6dd-d912-1fd8-5674e48f5c5b` (2026-06-29, 13:05:43–21:46:20 UTC, ~8.7hr duration)
**Related to:** `session_length_investigation_2026-06-30.md` (H1 hypothesis: *"the 5-minute timer-driven snapshot alone keeps resetting the idle clock on an otherwise-abandoned tab"*)
**Tooling:** `analysis/` pipeline in this repo (pulls session data from prod via Superset SQL Lab into a local scratch ClickHouse, computes per-session interval/gap metrics)

---

## 1. Context

The storage-cost investigation (`session_length_investigation_2026-06-30.md`) proposed three hypotheses for why sessions run far longer than expected:

- **H1** — the periodic FullSnapshot (fires every 5 min per rrweb's `checkoutEveryNms` config) resets the client idle timer on an abandoned tab, independent of real activity.
- **H2** — Whatfix analytics noise resets the idle timer independent of genuine user activity.
- **H3** — long sessions reflect real, sustained engagement.

H1 was framed as: *the FullSnapshot fires on its own clock*, which would mean a truly idle, abandoned tab keeps "recording" purely because of this timer.

While spot-checking a real long session (`f1cc7808...`) through the Phase-1 analysis pipeline, we found direct evidence that refines this: **the periodic FullSnapshot is not self-sustaining — it's a downstream reaction to unrelated, ongoing background DOM activity.**

---

## 2. The session in question

`session_interval_summary` output for `f1cc7808-a6dd-d912-1fd8-5674e48f5c5b`:

| Metric | Value |
|---|---|
| `duration_s` | 31,237 (8h 40m 37s) |
| `max_no_user_event_gap_s` | 6,080 (~101 min) — largest gap with no mouse/scroll/input |
| `no_user_event_interval_count` | 73 |
| `max_no_event_gap_s` | 2,279 (~38 min) — largest gap with **zero events of any kind** |
| `whatfix_event_count` | 237 |
| `mutation_event_count` | 1,658 |
| `mutation_to_whatfix_ratio` | ~7.0 |

The session is a genuine, long, mostly-engaged session (237 real Whatfix events) — but it contains one standout **101-minute stretch with zero user interaction** (16:24:36 → 18:05:56 UTC), worth understanding in detail.

---

## 3. Anatomy of the 101-minute gap

Breaking the gap into its three phases:

1. **16:24:36 → ~16:56 — tail of real engagement.** The gap technically starts right at the last `MouseInteraction` event, immediately followed by a burst of real Whatfix activity (a guide/tooltip firing), cascading into ~100+ chained Mutation/AdoptedStyleSheet DOM updates as the UI re-rendered. This is the system reacting to the user's last real action, not idle noise.

2. **~16:56 → 17:18 — the periodic-snapshot pattern, but gated on background activity.** After the Whatfix-driven burst settles, there is no more user or Whatfix activity — but a `Meta` + `Snapshot` + `AdoptedStyleSheet` burst still recurs every **~5–6 minutes**, e.g.:
   ```
   16:55:10  Snapshot
   17:01:10  Snapshot   (+5m 60.8s)
   17:07:10  Snapshot   (+6m 0.0s)
   17:13:10  Snapshot   (+6m 0.1s)
   ```

3. **17:18:10 → 17:56:09 — genuine dead air (38 min).** Even that pattern pauses, matching `max_no_event_gap_s = 2,279s` exactly. Then the same pattern resumes at 17:56:09.

---

## 4. What's actually between two consecutive Snapshots (16:55:10.003 → 17:01:10.813)

Full event-by-event breakdown, decoding `event_payload` (base64+zlib-compressed JSON) for each Mutation:

```
16:55:10.003  Snapshot                     ← previous checkout
16:56:09.847  AdoptedStyleSheet  ┐
  ... (14 AdoptedStyleSheet)      │  a ~2.2s settling burst
16:56:11.946  Mutation (adds=1)   │  (DOM nodes inserted)
16:56:12.083  Mutation (adds=1)  ┘
16:57:09.862  Mutation (texts=1)  →  {"id": 842, "value": "Updated 32 minutes ago"}
16:58:09.860  Mutation (texts=1)  →  {"id": 842, "value": "Updated 33 minutes ago"}
16:59:09.866  Mutation (texts=1)  →  {"id": 842, "value": "Updated 34 minutes ago"}
17:00:09.857  Mutation (texts=1)  →  {"id": 842, "value": "Updated 35 minutes ago"}
17:01:09.864  Mutation (texts=1)  →  {"id": 842, "value": "Updated 36 minutes ago"}
17:01:10.032  Meta
17:01:10.813  Snapshot                     ← next checkout fires
```

**Root cause identified**: a single DOM text node (`id: 842`) holding a relative timestamp label — **"Updated N minutes ago"** — is rewritten once every ~60.00 seconds by the page's own JS (a `setInterval`-driven UI element, e.g. a "last synced" indicator). This is the *only* thing happening on the page during this stretch. It is not user activity, not Whatfix activity — just a cosmetic, self-updating label.

---

## 5. Why this single ticking mutation causes a "periodic 5-minute snapshot" pattern

Verified directly against the rrweb source (`~/Documents/rrweb/packages/rrweb/src/record/index.ts:229–252`):

```ts
if (e.type === EventType.FullSnapshot) {
  lastFullSnapshotEvent = e;
  incrementalSnapshotCount = 0;
} else if (e.type === EventType.IncrementalSnapshot) {
  ...
  incrementalSnapshotCount++;
  const exceedCount =
    checkoutEveryNth && incrementalSnapshotCount >= checkoutEveryNth;
  const exceedTime =
    checkoutEveryNms &&
    e.timestamp - lastFullSnapshotEvent.timestamp > checkoutEveryNms;
  if (exceedCount || exceedTime) {
    takeFullSnapshot(true);
  }
}
```

**Key detail: this check only runs inside the handler for an `IncrementalSnapshot` event.** There is no independent `setInterval`/timer anywhere in rrweb driving `checkoutEveryNms`. It is purely reactive: *"when some incremental event just fired, check whether it's been more than `checkoutEveryNms` since the last FullSnapshot — if so, also take a new FullSnapshot now."*

This means: **on a genuinely idle page with zero DOM activity, no periodic FullSnapshot would fire at all** — there'd be no `IncrementalSnapshot` event to trigger the check. The "periodic every-5-minutes" pattern we observe is not a property of rrweb running its own clock; it's the once-a-minute "Updated N minutes ago" Mutation happening to be the event that's on duty when the 5-minute mark is crossed, at which point rrweb piggybacks a FullSnapshot onto it.

Confirmed with this session's config (`session_recorder/src/ts/config/config.ts:51`):
```ts
checkoutEveryNms: 5 * 60 * 1000,
```
— this is intentional, expected rrweb behavior, not a bug in rrweb.

---

## 6. Conclusion / how this refines H1

- **rrweb is not buggy.** `checkoutEveryNms` is documented, reactive-only behavior, working exactly as coded.
- **H1 as originally framed is slightly inaccurate.** The FullSnapshot mechanism cannot, by itself, keep a *truly* abandoned tab (zero DOM activity) recording — it needs *some* other incremental event to react to. The real driver of "keeping the session alive" in this case is whatever is generating that background Mutation, not the snapshot timer itself.
- **The actual root cause, at least for this session, is a cosmetic "time ago" label** ticking once a minute — completely decoupled from user presence or Whatfix engagement.

## 7. Recommendation

Whatever logic currently decides session/idle-timeout (not found in `session_recorder`'s own source — likely lives in a wrapping SDK such as `w3o-whatfix-widget`, `w3o-whatfix-embed`, or `wfx-react-middleware`) should **not** treat every rrweb event as "activity" for the purpose of extending a recording session. Specifically:

- A single, isolated text-node mutation on the *same* DOM node, recurring at a fixed cadence (e.g. once/minute), is a strong signature of a cosmetic UI ticker, not user engagement, and could be explicitly excluded from idle-timer resets.
- More generally, idle/session-continuation decisions should be based on `is_user_driven` events (mouse/scroll/input) and/or genuine Whatfix engagement — exactly the distinction this repo's `session_interval_summary` pipeline already makes (`max_no_user_event_gap_s` vs `max_no_event_gap_s`) — rather than "any rrweb event happened."
- This is a plausible, cheap contributor to the 8hr+ session bucket's storage cost (Section 8 of the storage investigation): sessions can be kept alive indefinitely by a single innocuous ticking element, well past the point of any real user or product engagement.

## Appendix — reproducing this

Using this repo's `analysis/` pipeline:
```bash
cd analysis
./venv/bin/python -c "
import pull_and_load
pull_and_load.load_sessions('d96d0adf-4b0d-4458-9c13-9146ec6a35f1', ['f1cc7808-a6dd-d912-1fd8-5674e48f5c5b'])
"
# then query unified_events / session_raw_events (event_payload decoded via rrweb_decode.py)
# against the local ClickHouse at localhost:8123 (password: local-dev-only)
```
