# Session Replay Viewer — Architecture

## 1. High-Level Design (HLD)

### 1.1 Purpose
A local developer tool for replaying and inspecting Whatfix session-replay recordings (rrweb events + Whatfix product-analytics events) for a given enterprise/session ID, without needing access to Whatfix's internal dashboards.

### 1.2 System Context

```
┌────────────┐        HTTPS (session cookie)        ┌──────────────────────────────┐
│  Browser   │ ───────────────────────────────────▶ │ Vite Dev Server              │
│  (React    │ ◀─────────────────────────────────── │  /api/* → proxy              │
│   SPA)     │                                       │  → whatfix.com/service/      │
└────────────┘                                       │      analytics/...            │
                                                       └──────────────┬────────────────┘
                                                                      │ HTTPS (forwarded cookie)
                                                                      ▼
                                                       ┌──────────────────────────────┐
                                                       │ Whatfix Session Replay API   │
                                                       │  - /index                    │
                                                       │  - /events (whatfix events)  │
                                                       │  - /events (rrweb chunks)    │
                                                       └──────────────────────────────┘
```

There is no first-party backend — the app is a single-page React app served by Vite, which also acts as a dev-time CORS/cookie-forwarding proxy to Whatfix's real analytics endpoints. All session data (entId, sessionId, cookie) is supplied manually by the user via a form; nothing is persisted server-side.

### 1.3 Major Components

| Component | Responsibility |
|---|---|
| **Config Form** (`App.tsx`) | Collect `entId`, `sessionId`, session `cookie`, `timezone`; kick off session load; show load progress/errors |
| **API layer** (`services/api.ts`) | Fetch index, Whatfix events, and rrweb event chunks from the proxied Whatfix API |
| **Decoder** (`services/decoder.ts`) | Decompress/deserialize raw `eventData` (gzip+base64, or plain base64) into rrweb `RRWebEvent` objects |
| **Session Viewer** (`components/SessionViewer.tsx`) | Top-level layout: player, stats, timeline, event list; merges rrweb + Whatfix events into one unified, time-ordered stream |
| **RRWeb Player** (`components/RRWebPlayer.tsx`) | Wraps rrweb's `Replayer` to visually replay the recorded DOM/session inside an iframe, with play/pause/speed/scrub controls |
| **Event Timeline** (`components/EventTimeline.tsx`) | Canvas-rendered swim-lane visualization of all events by category over time, with idle-gap detection and click-to-seek |
| **Event List** (`components/EventList.tsx`) | Virtualized/windowed table of all unified events, filterable by category, expandable to raw JSON, synced to playback position |
| **Event classification** (`utils/eventLabels.ts`) | Maps raw rrweb/Whatfix payloads into a common `UnifiedEvent` shape (category, type, subtype, human-readable detail) |
| **Dev Proxy** (`vite.config.ts`) | Rewrites `/api/*` to Whatfix's real API, forwards the user-supplied cookie via `x-forwarded-cookie` → `Cookie` header, relaxes CSP/CORS so the replayed page's cross-origin assets can load |

### 1.4 Data Flow (current implementation)

1. User submits `entId` / `sessionId` / `cookie` / `timezone`.
2. `loadSession()`:
   - Fetches the session **index** (list of `{timestamp, type}` entries marking start/snapshot/end points) and **Whatfix events** in parallel.
   - Builds one time window per **consecutive pair of index entries** and fetches an rrweb event chunk for each window, sequentially, reporting progress.
   - Each chunk's raw rows are decoded (`decodeEventData`) into `RRWebEvent[]`, concatenated, and sorted by timestamp.
3. Result (`rrwebEvents`, `whatfixEvents`, `indexEntries`, `startTs`, `endTs`) is stored as `LoadedSession` and handed to `SessionViewer`.
4. `SessionViewer` merges rrweb + Whatfix events into a single sorted `UnifiedEvent[]` and renders the player, timeline, and event list, all synced by a shared `currentTimeMs` / `seekToMs` state.

> **Known limitation (see `session-replay-apis.md` plan and `session_length_investigation_2026-06-30.md`):** because one API call is issued per consecutive index-entry pair, long sessions (24h+, snapshot every ~1s) generate thousands of calls and become unloadable. A two-phase redesign (index-only load → hourly picker → fixed 5-minute-bucket fetch, capped at 12 calls/hour) is planned but not yet implemented in `api.ts`/`App.tsx` — the code currently still uses the original per-index-pair `loadSession`.

### 1.5 Non-Functional Characteristics
- **No server-side persistence** — cookie and all fetched data live only in browser memory for the life of the tab.
- **Client-heavy rendering** — timeline uses a raw `<canvas>` for performance with tens of thousands of events; event list windows to 2000 DOM rows max.
- **Security posture** — session cookie is pasted by the user into a text field and forwarded via a custom header (`x-forwarded-cookie`); the dev proxy strips CORS restrictions and relaxes CSP/COEP/COOP only for local development use against a trusted (self-owned) analytics account.

---

## 2. Low-Level Design (LLD)

### 2.1 Type Model (`src/types.ts`)

- `IndexEntry { timestamp, type: 'start'|'snapshot'|'end' }` — one row of the session index.
- `WhatfixEvent { eventKey, eventName, timestamp }` — a product-analytics event (e.g. guided-tour step, click).
- `RRWebEventRow { hitId, userId, eventTimestamp, eventSeqNo, eventType, pageUrl, eventData, properties? }` — raw wire format for an rrweb event as stored by Whatfix (compressed payload in `eventData`).
- `RRWebEvent { type, data, timestamp }` — decoded, rrweb-library-native event shape (consumed directly by `rrweb`'s `Replayer`).
- `SessionConfig { entId, sessionId, cookie, timezone }` — user-supplied identifiers, threaded through every API call.
- `LoadedSession { config, indexEntries, rrwebEvents, whatfixEvents, startTs, endTs }` — the fully loaded, in-memory session used by the viewer.

### 2.2 API Layer (`src/services/api.ts`)

| Function | Endpoint | Notes |
|---|---|---|
| `fetchIndex(config)` | `GET /api/session_replay/{entId}/index?sessionId=` | Returns `IndexEntry[]`. |
| `fetchWhatfixEvents(config)` | `POST /api/session_replay/{entId}/session/{sessionId}/events` (body: `{data:{timezone}, withCredentials:false}`) | Returns `WhatfixEvent[]`. |
| `fetchRRWebChunk(config, startTs, endTs)` | `GET /api/session_replay/{entId}/events?sessionId=&startTs=&endTs=` | Returns decoded `RRWebEvent[]` for the given time window (via `decodeEventData`, invalid rows filtered out). |
| `loadSession(config, onProgress?)` | orchestrates the above | Builds `[timestamps[i], timestamps[i+1]]` windows from every consecutive index-entry pair, fetches each window's chunk **sequentially**, concatenates + sorts by timestamp. Reports `(loaded, total)` via `onProgress` after each window. |

All requests go through `headers(cookie)`, which sets `x-forwarded-cookie` — never a real `Cookie` header (browsers forbid setting that directly) — for the Vite proxy to translate.

### 2.3 Decoder (`src/services/decoder.ts`)
`decodeEventData(base64String)`:
1. Base64-decode → bytes.
2. `pako.inflate(bytes, {toText:true})` → JSON string → `JSON.parse` → `RRWebEvent`.
3. Fallback: if inflate/parse fails, try plain `atob` + `JSON.parse` (uncompressed rows).
4. Returns `null` on total failure; callers filter nulls out.

### 2.4 Dev Proxy (`vite.config.ts`)
- `/api/*` → `https://whatfix.com/service/analytics/*` (path prefix stripped).
- `proxyReq` hook: reads `x-forwarded-cookie` from the incoming request, sets it as the real `Cookie` header on the upstream request, removes the custom header.
- `proxyRes` hook: sets `Access-Control-Allow-Origin: *` so the SPA (different origin/port) can read the response.
- Server-wide CSP/COEP/COOP/CORP headers are relaxed (`unsafe-inline`, `unsafe-eval`, wildcard sources) so the rrweb-replayed page's original cross-origin scripts/fonts/images render inside the sandboxed iframe.

### 2.5 App Shell (`src/App.tsx`)
- Local state: `entId`, `sessionId`, `cookie`, `timezone` (defaulted to `Intl.DateTimeFormat().resolvedOptions().timeZone`), `loading`, `progress`, `error`, `session`.
- `handleLoad`: validates required fields → calls `loadSession` with a progress callback that updates the submit button label (`Loading chunk N/M…`) → computes `startTs`/`endTs` as min/max of index timestamps → sets `session` → renders `SessionViewer`.

### 2.6 SessionViewer (`src/components/SessionViewer.tsx`)
- Derives `duration = endTs - startTs`.
- `unifiedEvents = buildUnifiedEvents(rrwebEvents, whatfixEvents, startTs)` (memoized).
- Owns `currentTimeMs` (fed by the player's polling) and `seekToMs` (fed by timeline/list clicks) as the single source of truth for playback position, passed down to all three children.
- Renders: stat cards (event counts, snapshot count, duration) + `RRWebPlayer` + `EventTimeline` + `EventList`.

### 2.7 Event Classification (`src/utils/eventLabels.ts`)
- `classifyRRWeb(event, startTs, index)`: switches on rrweb `event.type` (2=FullSnapshot, 3=IncrementalSnapshot, 4=Meta, 5=Custom); for type 3, further switches on `data.source` (0=Mutation, 1/6=MouseMove, 2=MouseInteraction, 3=Scroll, 5=Input, else generic "Incremental") to build a human-readable `subtype`/`detail` string (e.g. mutation counts, mouse-interaction name, truncated input text).
- `classifyWhatfix(event, startTs, index)`: wraps a `WhatfixEvent` into the same `UnifiedEvent` shape under category `'whatfix'`.
- `buildUnifiedEvents(...)`: maps + concatenates both arrays and sorts by `offsetMs`.
- `UnifiedEvent { id, offsetMs, category, type, subtype, detail, raw }` is the shared shape consumed by both the timeline and the list.

### 2.8 RRWebPlayer (`src/components/RRWebPlayer.tsx`)
- On `events` change: tears down any previous `Replayer`, reads the `Meta` event (type 4) for recorded viewport `width`/`height`, constructs a new `rrweb` `Replayer` with `blockSelector: 'iframe'` (blocks cross-origin nested iframes to avoid "Unsafe attempt to load URL" console errors), pauses at `t=0`.
- Scales the replayer's internal iframe via CSS `transform: scale(...)` computed from container width vs. recorded dimensions (double-`requestAnimationFrame` to wait for layout), re-computed on `ResizeObserver`.
- Polls `replayer.getCurrentTime()` every 100 ms (more reliable than rrweb's `ui-update-current-time` event) to drive `currentMs` and bubble it up via `onCurrentTime`.
- Reacts to external `seekToMs` prop changes by calling `replayer.play(ms)` or `.pause(ms)` depending on whether playback is active.
- Controls: play/pause toggle, scrub `<input type="range">`, and speed buttons (0.5×/1×/2×/4× via `replayer.setConfig({speed})`).

### 2.9 EventTimeline (`src/components/EventTimeline.tsx`)
- Pure `<canvas>` renderer (no per-event DOM nodes) — necessary because sessions can carry tens of thousands of events.
- Fixed lane list: snapshot / mutation / mouse / scroll / input / whatfix / other, each with its own color.
- For each lane: buckets that lane's events into pixel columns (`Set<number>` of column indices) to avoid drawing more ticks than there are pixels.
- `computeIdleRegions`: finds gaps between consecutive (all-category, time-sorted) events larger than `IDLE_THRESHOLD_MS` (5s) and renders them as dimmed, dashed-bordered regions with a duration pill label — helps spot dead time in long recordings.
- Draws a time axis (start/mid/end labels) and a playhead triangle+line at `currentTimeMs`.
- Re-renders on every prop change and on `ResizeObserver` container resize.
- Click handling maps canvas X back to an offset in ms and calls `onSeek`.

### 2.10 EventList (`src/components/EventList.tsx`)
- Category filter bar (`all` + the 6 categories) with live counts.
- `nearestIdx`: linear scan (with early-exit once no further improvement is possible) to find the event closest to `currentTimeMs`, used to highlight the "current" row.
- **Windowing**: if the filtered list exceeds `MAX_ROWS` (2000), only a 2000-row slice centered on `nearestIdx` is rendered as actual `<tr>` elements — keeps the DOM bounded regardless of session size. Shows a "showing X–Y of Z" note when windowed.
- Auto-scroll (`followPlayback` toggle): scrolls the current row into view when the windowed nearest-index changes, using a ref to avoid redundant scrolls.
- Row click: seeks the player to that event's offset and toggles an inline expanded `<pre>` block with the full raw JSON (`evt.raw`).

### 2.11 EventDetail (`src/components/EventDetail.tsx`)
- Presentational component for showing a selected Whatfix event and/or the nearest rrweb event side-by-side with formatted timestamps and raw JSON. **Currently not wired into `SessionViewer`** — appears to be either a leftover from an earlier layout or a component pending integration.

### 2.12 Planned Redesign (documented, not yet implemented)
`session-replay-apis.md` (top-level plan doc) specifies the following changes to fix the "1734 API calls for a 30-minute session" problem — cross-reference before assuming current behavior matches:
- New `fetchSessionIndex()` (index + Whatfix events only, 2 calls) replacing eager full-session load.
- New `loadHourEvents(config, hourStartTs, hourEndTs, onProgress)` using **fixed 5-minute buckets** (not index-entry pairs) — caps any hour at 12 calls regardless of snapshot density.
- New `SessionIndex` type and a new `HourPicker` component shown between index-load and event-load, with per-hour snapshot-density bars; sessions ≤ 1 hour skip the picker.
- `App.tsx` moves from single `session` state to `indexData` + `session` two-phase state.
