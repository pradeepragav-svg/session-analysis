# Question
/Users/pradeep/Documents/git/session-analysis/session-viewer.png

I have built a session recording viewer which shows the events. How do I transform the data so that I can identify sessions like

1. Maximum inactivity in a session
2. Interval without user events - No mouse, input, scroll events 
3. Sessions not having whatfix events
4. Interval having only whatfix events or rrweb events triggered due to whatfix events 
5. Intervals only driven due to mutations on the page 
Now I am doing it manually but it is not scalable 

The objective is to get insights on the session so that we can have action items


# Answer

This is a great concrete case to walk through, because — important reframe — **none of these five things need an LLM at all.** They're deterministic sequence/interval-detection problems over a sorted event stream. The LLM's job comes *after* you've computed these features, when you turn numbers into a narrative/action items across many sessions. Let's separate the two layers.

## Layer 1: Turn the event stream into structured intervals (no ML)

Right now your viewer shows a flat list of typed events. What you need first is a canonical, flat table per session:

```
session_id | event_id | ts_ms | top_type | sub_type | is_user_driven | is_whatfix
```

Where `top_type` is your existing bucket (Snapshot / Mutation / Mouse / Scroll / Input / Whatfix / Other) and `is_user_driven` is a derived boolean: `true` for Mouse/Scroll/Input, `false` for Snapshot/Mutation/Other, and Whatfix gets its own flag since it's neither.

Everything else is the classic **"gaps and islands"** SQL pattern, which you already have all the tooling for in ClickHouse.

### 1. Max inactivity in a session

Sort user-driven events by `ts_ms`, take the diff to the previous one, max it:

```sql
SELECT
  session_id,
  max(gap_ms) AS max_inactivity_ms
FROM (
  SELECT
    session_id,
    ts_ms - lagInFrame(ts_ms) OVER (PARTITION BY session_id ORDER BY ts_ms) AS gap_ms
  FROM events
  WHERE is_user_driven = 1
)
GROUP BY session_id
```

### 2. All intervals without user events (not just the max)

Same gap computation, but instead of taking `max()`, keep every gap above a threshold (say 5s) as its own row — that's your inactivity-interval table directly (start = previous event ts, end = current event ts, duration = gap_ms). No island-grouping needed here since a "gap between two consecutive user events" *is* the interval.

```sql
SELECT
  session_id,
  lagInFrame(ts_ms) OVER (PARTITION BY session_id ORDER BY ts_ms) AS interval_start,
  ts_ms AS interval_end,
  ts_ms - lagInFrame(ts_ms) OVER (PARTITION BY session_id ORDER BY ts_ms) AS gap_ms
FROM events
WHERE is_user_driven = 1
QUALIFY gap_ms > 5000
```

### 3. Sessions with zero Whatfix events

Trivial aggregate, one row per session:

```sql
SELECT session_id, countIf(is_whatfix = 1) = 0 AS no_whatfix_events
FROM events
GROUP BY session_id
```

### 4 & 5 are the interesting ones — they need **causal attribution**, not just filtering

The hard part isn't detecting "only Whatfix events in a window" — it's that a Whatfix element injection or highlight *causes* a burst of Mutation events that aren't really independent activity. Same with #5: a mutation-only interval might actually be Whatfix-driven, and you don't want to double count it as "unexplained mutation churn."

So you need a **labeling pass before interval detection**: tag each Mutation event as `attributed_to = 'whatfix'` if it falls within a short window (e.g. 200–500ms — you'll want to empirically tune this from a few sessions) after a preceding Whatfix event, with no intervening user-input event. This is a sequential state-machine problem. In ClickHouse you can approximate it with a window function:

```sql
SELECT
  *,
  ts_ms - lagInFrame(ts_ms) OVER w AS ms_since_prev,
  lagInFrame(top_type) OVER w AS prev_type
FROM events
WINDOW w AS (PARTITION BY session_id ORDER BY ts_ms)
```

then in a second pass, walk forward: any `Mutation` where `prev_type = 'Whatfix'` and `ms_since_prev < threshold` gets `attributed_to='whatfix'`; you'll want to propagate that attribution forward through a *chain* of mutations (mutation A triggers mutation B triggers mutation C), which is genuinely easier to do as a small Python/pandas pass per session than in pure SQL — a sequential scan with a "last real cause" pointer. Given the volumes you're dealing with, a UDF or a materialized batch job (Spark/pandas over ClickHouse exports) is more maintainable than nested window-function gymnastics.

Once every event has an `attributed_to` label (`user`, `whatfix`, `unattributed_mutation`, `system`), #4 and #5 become the same gaps-and-islands pattern as before, just grouping by run of identical label instead of by gap size:

```sql
SELECT
  session_id, attributed_to,
  sum(1 - runStart) OVER (...) AS island_id  -- run-length encoding trick
FROM (
  SELECT *,
    if(attributed_to != lagInFrame(attributed_to) OVER w, 1, 0) AS runStart
  FROM labeled_events
  WINDOW w AS (PARTITION BY session_id ORDER BY ts_ms)
)
```
Then `GROUP BY session_id, island_id` to get interval start/end/duration/event-count per contiguous run.

## Layer 2: Where the LLM actually helps

Once you have, per session, a small feature vector like:

```json
{
  "session_id": "...",
  "duration_s": 4465,
  "max_inactivity_s": 2100,
  "inactive_interval_count": 3,
  "whatfix_event_count": 113,
  "whatfix_driven_duration_pct": 22,
  "unattributed_mutation_duration_pct": 8,
  "has_whatfix_events": true
}
```

*this* is what you hand to an LLM — not raw events. Two genuinely useful patterns:

- **Per-session narrative**: feed the feature vector, get "this session recorded 4465s but 2100s (47%) was a single idle gap with zero user activity — likely a tab left open, not real engagement."
- **Cross-session insight/action items**: aggregate the feature vectors across hundreds of sessions (percentiles, histograms — plain SQL), then hand *those aggregates* to the LLM to draft a prioritized action-item list, e.g. "X% of sessions have >30% idle time — consider auto-pausing capture after N seconds of inactivity to cut storage cost."

Given what you told me you're already chasing (recordings running longer than expected, storage cost concerns), #1/#2 and the idle-time percentage are directly load-bearing for that investigation — an auto-pause-on-inactivity policy driven by exactly this metric could be a real cost lever, not just an analytics nicety.

One practical note: build this as a **batch job that writes back into ClickHouse** (a `session_interval_summary` table keyed by session_id), not as something computed on-the-fly in your viewer — that keeps it queryable/aggregable the way the rest of your pipeline already is, and your viewer can just read pre-computed intervals to render annotations on the timeline you've already built.

Want me to sketch the Python/pandas pass for the Whatfix-attribution labeling specifically? That's the one piece that's genuinely awkward in pure SQL.


# Implementation

Step 1 : Using superset-mcp, pull each session from events table and session_raw_events table. 
Step 2 : Populate the local superset tables 
Step 3 : Matviews for doing 1 to 3 (Answer)
Step 4 : Work on transforming the data for 4 and 5
Step 5 : Since the data in production is massive after processing for each session drop the events and sesison_raw_events entries for the processed session id 

# Queries in production 

Insight Query | session_replay_listing | Caching status : true | execution time : 56| query: SELECT     combined.session_id,     combined.user_id,     toDateTime(combined.start_time, 'America/New_York') AS session_start_time,     toDateTime(combined.end_time,   'America/New_York') AS session_end_time,     combined.duration                             AS duration,     ru.resolved_user                              AS user_name,     count() OVER ()                               AS total_count,     'd96d0adf-4b0d-4458-9c13-9146ec6a35f1'                                     AS ent_id FROM (     SELECT         sre.session_id,         any(sre.user_id)                                                   AS user_id,         min(sre.created_at)                                                AS start_time,         max(sre.created_at)                                                AS end_time,         dateDiff('millisecond', min(sre.created_at), max(sre.created_at)) AS duration     FROM session_raw_events AS sre     PREWHERE sre.ent_id = 'd96d0adf-4b0d-4458-9c13-9146ec6a35f1'     WHERE sre.session_id IN (SELECT DISTINCT wfx_usr_session_id AS session_id  FROM events  WHERE  src_id != 'site' and hostname NOT IN ['cdn.whatfix.com'] and (ent_id = 'd96d0adf-4b0d-4458-9c13-9146ec6a35f1') AND (toDate32(created_at, 'America/New_York') between '2026-06-23' and '2026-06-29')  AND (type in ['HUB_TASK_MARK_COMPLETE' , 'HUB_EXPLORER_CONTENT' , 'HUB_PIN_TASK_CLICK' , 'HUB_EXPLORER_SEARCH_FILTERS_APPLIED' , 'SMART_TIP_CLOSE' , 'SEARCH' , 'BRANCH_LIVE_START' , 'TASK_LIST_NUDGE' , 'FLOW_LIVE_BACK_AND_MISS' , 'EMBED_LOADED' , 'END_POPUP_CLOSE_BUTTON' , 'SURVEY_CROSS' , 'SH_QUICKREAD_TOOLTIP_CLICKED' , 'APPHUB_EXPLORER_SEARCH_FILTERS_APPLIED' , 'TASK_LIST_LOADED' , 'WORKFLOW_END_MIRROR' , 'SELF_HELP_ENGAGED' , 'TEXT_END' , 'POPUP_DO_NOT_SHOW' , 'FLOW_CLOSURE_FEEDBACK_OPT_OUT' , 'HUB_NOTIFICATION_SNOOZE_APPLIED' , 'TIP_VALIDATE_VALID' , 'PDF_START' , 'END_POPUP_CLOSE' , 'SMART_TIP_MISS' , 'CUE_CLICKED' , 'FLOW_COMPLETED' , 'SMART_TIP_AUTO_COMPLETION_VIA_SCROLL' , 'NEW_POPUP_SKIP' , 'HUB_PIN_SETTINGS_CLICK' , 'APPHUB_PIN_ICON_CLICK' , 'CUE_CLOSED' , 'TASK_LIST_ENGAGED' , 'CUE_COLLECT_FEEDBACK' , 'HUB_NEW_POPUP_LOADED' , 'LAUNCHER_CLICKED' , 'FLOW_VIEW_START' , 'HUB_SYSTEMTRAY_QUIT' , 'WF_RP_COMPETENCY' , 'APPHUB_NO_SEARCH_RESULTS' , 'FLOW_VIEW_CLOSE_AT_START' , 'APPHUB_EXPLORER_CONTENT' , 'APPHUB_NO_SEARCH_RESULTS_FEEDBACK_SUBMIT' , 'FLOW_LIVE_BACK' , 'TL_TASK_COMPLETION' , 'FLOW_LIVE_MISS' , 'TOOLTIP_BUTTON_CLICKED' , 'HUB_EXPLORER_QUICKREAD_FEEDBACK' , 'HUB_NOTIFICATION_CLICK' , 'TEXT_START' , 'HUB_TASK_LOADED' , 'APPHUB_PIN_EXPLORER_CLICK' , 'NOTIFICATION_CLOSED' , 'LIVE_START' , 'self_help_search_feedback' , 'NEW_POPUP_CLOSE_BY_BUTTON' , 'hub_search_feedbacks add_to_stage' , 'HUB_TASK_DETAIL_CONTENT' , 'HUB_POPUP_DO_NOT_SHOW' , 'WF_RP_COMPLETE' , 'SURVEY_REFRESH' , 'BEACON_LOADED' , 'CUS_EXT_INSTALLED' , 'TL_SEGMENT_COMPLETION' , 'enduser_feedbacks add_to_stage' , 'APPHUB_PIN_TASKLIST_CLICK' , 'HUB_PIN_SETTINGS_SNOOZE_NOTIFICATION_CLICK' , 'APPHUB_EXPLORER_QUICKREAD_RESPONSE' , 'HUB_EXPLORER_SUGGESTIONS' , 'HUB_NO_SEARCH_RESULTS' , 'HUB_NEW_POPUP_SKIP' , 'LAUNCHER_LOADED' , 'SELF_HELP_FEEDBACK_PROVIVED' , 'APPHUB_TOP_NAV_CHATBOT' , 'APPHUB_TASKLIST_GROUP_CLICKED' , 'TIP_VALIDATE_RECTIFIED' , 'HUB_NO_SEARCH_RESULTS_FEEDBACK_SUBMIT' , 'BLOCKER_LOADED' , 'APPHUB_TASKLIST_ALL_PILL_CLICKED' , 'HUB_NEW_POPUP_START_URL' , 'FLOW_LIVE_AUTO_CLOSE' , 'HUB_PIN_EXPLORER_CLICK' , 'TASK_LIST_CLOSE' , 'APPHUB_EXPLORER_QUICKREAD_FEEDBACK' , 'FLOW_REVIEWED' , 'CARD_MEDIA_CLICK' , 'APPHUB_PIN_LOADED' , 'HUB_TASK_DETAILS' , 'LINK_START' , 'HUB_TOP_NAV_FEEDBACK' , 'HUB_END_USER_FEEDBACK' , 'FLOW_LIVE_RESUME' , 'SMART_TIP_AUTO_COMPLETE' , 'HUB_COPILOT_ACTIVATED' , 'BEACON_CLICKED' , 'POPUP_SKIP' , 'NEW_POPUP_DO_NOT_SHOW' , 'QUICKREAD_LINKS' , 'HUB_EXPLORER_QUICKREAD_FEEDBACK_SUBJECTIVE' , 'END_POPUP_CLOSE_CROSS' , 'FLOW_FAILURE' , 'HUB_COPILOT_SUGGESTION_USED' , 'APPHUB_EXPLORER_SUGGESTIONS' , 'HUB_SYSTEMTRAY_SHOWN' , 'HUB_NOTIFICATION_SNOOZE_CLICK' , 'LINK_CLICK' , 'BEACON_HOVER' , 'APPHUB_EXPLORER_SEARCH' , 'APPHUB_TASKLIST_TODO_PILL_OPEN' , 'SMART_TIP_LOADED' , 'HUB_SHORTCUT_KEY' , 'HUB_TASKBAR_SHOWN' , 'FLOW_VIEW_RESTART' , 'HUB_PIN_CHATBOT_CLICK' , 'EXTNESION_INSTALLED' , 'APPHUB_TASKLIST_COMPLETE_PILL_OPEN' , 'INSTALL' , 'SURVEY_CLOSE' , 'FLOW_LIKERT' , 'NEW_POPUP_CAROUSEL_SLIDE' , 'SELF_HELP_EMAIL_CAPTURED' , 'HUB_COPILOT_CHAT_USED' , 'APPHUB_TASKLIST_COMPLETE_PILL_CLICKED' , 'NOTIFICATION_CLICKED' , 'WORKFLOW_START_MIRROR' , 'HUB_POPUP_CLOSE_CROSS' , 'HUB_PIN_TASKBAR_UNHIDE' , 'NEW_POPUP_START_URL' , 'SELF_HELP_FEEDBACK_SENT' , 'APPHUB_TOP_NAV_EXPLORER' , 'CARD_CLOSE' , 'APPHUB_EXPLORER_QUICKREAD_FEEDBACK_SUBJECTIVE' , 'FLOW_VIEW_STEP' , 'NEW_POPUP_LOADED' , 'FLOW_LIVE_STEP' , 'APPHUB_TASKLIST_OPEN' , 'HUB_END_POPUP_CLOSE_CROSS' , 'NEW_POPUP_START_FLOW' , 'SURVEY_DO_NOT_SHOW' , 'HUB_ONBOARDING_NUDGE_CLICKED' , 'NOTIFICATION_MOUSEOVER' , 'APPHUB_TOP_NAV_FEEDBACK' , 'FLOW_LIVE_END' , 'NEW_POPUP_CLOSE' , 'WF_RP_START' , 'WF_RP_END' , 'BLOCKER_HOVER' , 'HUB_TASKBAR_QUIT' , 'SELF_HELP_EMAIL_PROVIVED' , 'CUE_LOADED' , 'SMART_TIP_SHOW' , 'HUB_PIN_LOADED' , 'SURVEY_MAXIMIZE' , 'HUB_SYSTEMTRAY_CLICKED' , 'POPUP_LOADED' , 'WORKFLOW_LIVE_COMPLETE' , 'CARD_DRAGGED_TO' , 'HUB_TOP_NAV_EXPLORER' , 'HUB_PIN_HIDE_CLICK' , 'ASSESSMENT_START_MIRROR' , 'EXTENSION_UPDATION' , 'VIDEO_START' , 'POPUP_START' , 'DESKTOP_FLOW_FEEDBACK' , 'HUB_SYSTEMTRAY_QUIT_CONFIRM' , 'ASSESSMENT_END_MIRROR' , 'NOTIFICATION_LOADED' , 'FLOW_LIVE_AUTO_SWITCH' , 'HUB_EXPLORER_QUICKREAD_RESPONSE' , 'EXTENSION_GENERATION' , 'SELF_HELP_FEEDBACK_SEEN' , 'FLOW_LIVE_CLOSE' , 'BLOCKER_CLICKED' , 'APPHUB_TASKLIST_TODO_PILL_CLICKED' , 'HUB_APP_LOADED' , 'TIP_VALIDATE_ERROR' , 'SELF_HELP_CLOSE' , 'APPHUB_TOP_NAV_TASKLIST' , 'SELF_HELP_LOADED' , 'SURVEY_LOADED' , 'HUB_EXPLORER_QUICKREAD_LINKS' , 'HUB_EXPLORER_SEARCH' , 'SURVEY_MINIMIZE' , 'POPUP_CLOSE' , 'BADGE_CLICKED' , 'HUB_PIN_ICON_CLICK' , 'HUB_TASKS_LOADED' , 'SURVEY_SUBMIT' , 'HUB_TOP_NAV_TASKS' , 'FLOW_LIVE_COMPLETE' , 'FLOW_VIEW_END' , 'HUB_TOP_NAV_NOTIFICATIONS_CLICK' , 'HUB_PIN_NOTIFICATIONS_CLICK' , 'APPHUB_EXPLORER_QUICKREAD_LINKS' , 'CUE_SNOOZED' , 'APPHUB_PIN_FEEDBACK_CLICK' , 'HUB_PIN_FEEDBACK_CLICK' , 'FLOW_LIVE_CHANGE' , 'APPHUB_END_USER_FEEDBACK' , 'DESKTOPWALLPAPER_SHOWN' , 'QUICKREAD_RESPONSE' , 'APPHUB_TASKLIST_ALL_PILL_OPEN' , 'APPHUB_PIN_CHATBOT_CLICK' , 'hub_enduser_feedbacks add_to_stage' , 'FLOW_FEEDBACK' , 'HUB_TOP_NAV_CHATBOT' , 'search_feedbacks add_to_stage' , 'HUB_TASKBAR_CLICKED' , 'FLOW_CLOSURE_FEEDBACK' , 'BADGE_MOUSEOVER' , 'FLOW_LIVE_STOP' , 'HUB_NEW_POPUP_START_FLOW' , 'HUB_TASK_FILTER' , 'QUICKREAD_FEEDBACK' , 'FLOW_VIEW_CLOSE']) AND (category = 'whatfix')     )       AND sre.session_id NOT IN (           SELECT DISTINCT session_id           FROM wfx_olap2.session_replay_metadata           WHERE ent_id = toUUID('d96d0adf-4b0d-4458-9c13-9146ec6a35f1')       )     GROUP BY sre.session_id     HAVING toDate32(min(sre.created_at), 'America/New_York') BETWEEN '2026-06-23' and '2026-06-29'     UNION ALL     SELECT         srm.session_id,         toUUID(any(srm.user_id))                                                   AS user_id,         min(srm.chunk_start_ts)                                                    AS start_time,         max(srm.chunk_end_ts)                                                      AS end_time,         dateDiff('millisecond', min(srm.chunk_start_ts), max(srm.chunk_end_ts))    AS duration     FROM wfx_olap2.session_replay_metadata AS srm     WHERE srm.ent_id = toUUID('d96d0adf-4b0d-4458-9c13-9146ec6a35f1')       AND srm.session_id IN (SELECT DISTINCT wfx_usr_session_id AS session_id  FROM events  WHERE  src_id != 'site' and hostname NOT IN ['cdn.whatfix.com'] and (ent_id = 'd96d0adf-4b0d-4458-9c13-9146ec6a35f1') AND (toDate32(created_at, 'America/New_York') between '2026-06-23' and '2026-06-29')  AND (type in ['HUB_TASK_MARK_COMPLETE' , 'HUB_EXPLORER_CONTENT' , 'HUB_PIN_TASK_CLICK' , 'HUB_EXPLORER_SEARCH_FILTERS_APPLIED' , 'SMART_TIP_CLOSE' , 'SEARCH' , 'BRANCH_LIVE_START' , 'TASK_LIST_NUDGE' , 'FLOW_LIVE_BACK_AND_MISS' , 'EMBED_LOADED' , 'END_POPUP_CLOSE_BUTTON' , 'SURVEY_CROSS' , 'SH_QUICKREAD_TOOLTIP_CLICKED' , 'APPHUB_EXPLORER_SEARCH_FILTERS_APPLIED' , 'TASK_LIST_LOADED' , 'WORKFLOW_END_MIRROR' , 'SELF_HELP_ENGAGED' , 'TEXT_END' , 'POPUP_DO_NOT_SHOW' , 'FLOW_CLOSURE_FEEDBACK_OPT_OUT' , 'HUB_NOTIFICATION_SNOOZE_APPLIED' , 'TIP_VALIDATE_VALID' , 'PDF_START' , 'END_POPUP_CLOSE' , 'SMART_TIP_MISS' , 'CUE_CLICKED' , 'FLOW_COMPLETED' , 'SMART_TIP_AUTO_COMPLETION_VIA_SCROLL' , 'NEW_POPUP_SKIP' , 'HUB_PIN_SETTINGS_CLICK' , 'APPHUB_PIN_ICON_CLICK' , 'CUE_CLOSED' , 'TASK_LIST_ENGAGED' , 'CUE_COLLECT_FEEDBACK' , 'HUB_NEW_POPUP_LOADED' , 'LAUNCHER_CLICKED' , 'FLOW_VIEW_START' , 'HUB_SYSTEMTRAY_QUIT' , 'WF_RP_COMPETENCY' , 'APPHUB_NO_SEARCH_RESULTS' , 'FLOW_VIEW_CLOSE_AT_START' , 'APPHUB_EXPLORER_CONTENT' , 'APPHUB_NO_SEARCH_RESULTS_FEEDBACK_SUBMIT' , 'FLOW_LIVE_BACK' , 'TL_TASK_COMPLETION' , 'FLOW_LIVE_MISS' , 'TOOLTIP_BUTTON_CLICKED' , 'HUB_EXPLORER_QUICKREAD_FEEDBACK' , 'HUB_NOTIFICATION_CLICK' , 'TEXT_START' , 'HUB_TASK_LOADED' , 'APPHUB_PIN_EXPLORER_CLICK' , 'NOTIFICATION_CLOSED' , 'LIVE_START' , 'self_help_search_feedback' , 'NEW_POPUP_CLOSE_BY_BUTTON' , 'hub_search_feedbacks add_to_stage' , 'HUB_TASK_DETAIL_CONTENT' , 'HUB_POPUP_DO_NOT_SHOW' , 'WF_RP_COMPLETE' , 'SURVEY_REFRESH' , 'BEACON_LOADED' , 'CUS_EXT_INSTALLED' , 'TL_SEGMENT_COMPLETION' , 'enduser_feedbacks add_to_stage' , 'APPHUB_PIN_TASKLIST_CLICK' , 'HUB_PIN_SETTINGS_SNOOZE_NOTIFICATION_CLICK' , 'APPHUB_EXPLORER_QUICKREAD_RESPONSE' , 'HUB_EXPLORER_SUGGESTIONS' , 'HUB_NO_SEARCH_RESULTS' , 'HUB_NEW_POPUP_SKIP' , 'LAUNCHER_LOADED' , 'SELF_HELP_FEEDBACK_PROVIVED' , 'APPHUB_TOP_NAV_CHATBOT' , 'APPHUB_TASKLIST_GROUP_CLICKED' , 'TIP_VALIDATE_RECTIFIED' , 'HUB_NO_SEARCH_RESULTS_FEEDBACK_SUBMIT' , 'BLOCKER_LOADED' , 'APPHUB_TASKLIST_ALL_PILL_CLICKED' , 'HUB_NEW_POPUP_START_URL' , 'FLOW_LIVE_AUTO_CLOSE' , 'HUB_PIN_EXPLORER_CLICK' , 'TASK_LIST_CLOSE' , 'APPHUB_EXPLORER_QUICKREAD_FEEDBACK' , 'FLOW_REVIEWED' , 'CARD_MEDIA_CLICK' , 'APPHUB_PIN_LOADED' , 'HUB_TASK_DETAILS' , 'LINK_START' , 'HUB_TOP_NAV_FEEDBACK' , 'HUB_END_USER_FEEDBACK' , 'FLOW_LIVE_RESUME' , 'SMART_TIP_AUTO_COMPLETE' , 'HUB_COPILOT_ACTIVATED' , 'BEACON_CLICKED' , 'POPUP_SKIP' , 'NEW_POPUP_DO_NOT_SHOW' , 'QUICKREAD_LINKS' , 'HUB_EXPLORER_QUICKREAD_FEEDBACK_SUBJECTIVE' , 'END_POPUP_CLOSE_CROSS' , 'FLOW_FAILURE' , 'HUB_COPILOT_SUGGESTION_USED' , 'APPHUB_EXPLORER_SUGGESTIONS' , 'HUB_SYSTEMTRAY_SHOWN' , 'HUB_NOTIFICATION_SNOOZE_CLICK' , 'LINK_CLICK' , 'BEACON_HOVER' , 'APPHUB_EXPLORER_SEARCH' , 'APPHUB_TASKLIST_TODO_PILL_OPEN' , 'SMART_TIP_LOADED' , 'HUB_SHORTCUT_KEY' , 'HUB_TASKBAR_SHOWN' , 'FLOW_VIEW_RESTART' , 'HUB_PIN_CHATBOT_CLICK' , 'EXTNESION_INSTALLED' , 'APPHUB_TASKLIST_COMPLETE_PILL_OPEN' , 'INSTALL' , 'SURVEY_CLOSE' , 'FLOW_LIKERT' , 'NEW_POPUP_CAROUSEL_SLIDE' , 'SELF_HELP_EMAIL_CAPTURED' , 'HUB_COPILOT_CHAT_USED' , 'APPHUB_TASKLIST_COMPLETE_PILL_CLICKED' , 'NOTIFICATION_CLICKED' , 'WORKFLOW_START_MIRROR' , 'HUB_POPUP_CLOSE_CROSS' , 'HUB_PIN_TASKBAR_UNHIDE' , 'NEW_POPUP_START_URL' , 'SELF_HELP_FEEDBACK_SENT' , 'APPHUB_TOP_NAV_EXPLORER' , 'CARD_CLOSE' , 'APPHUB_EXPLORER_QUICKREAD_FEEDBACK_SUBJECTIVE' , 'FLOW_VIEW_STEP' , 'NEW_POPUP_LOADED' , 'FLOW_LIVE_STEP' , 'APPHUB_TASKLIST_OPEN' , 'HUB_END_POPUP_CLOSE_CROSS' , 'NEW_POPUP_START_FLOW' , 'SURVEY_DO_NOT_SHOW' , 'HUB_ONBOARDING_NUDGE_CLICKED' , 'NOTIFICATION_MOUSEOVER' , 'APPHUB_TOP_NAV_FEEDBACK' , 'FLOW_LIVE_END' , 'NEW_POPUP_CLOSE' , 'WF_RP_START' , 'WF_RP_END' , 'BLOCKER_HOVER' , 'HUB_TASKBAR_QUIT' , 'SELF_HELP_EMAIL_PROVIVED' , 'CUE_LOADED' , 'SMART_TIP_SHOW' , 'HUB_PIN_LOADED' , 'SURVEY_MAXIMIZE' , 'HUB_SYSTEMTRAY_CLICKED' , 'POPUP_LOADED' , 'WORKFLOW_LIVE_COMPLETE' , 'CARD_DRAGGED_TO' , 'HUB_TOP_NAV_EXPLORER' , 'HUB_PIN_HIDE_CLICK' , 'ASSESSMENT_START_MIRROR' , 'EXTENSION_UPDATION' , 'VIDEO_START' , 'POPUP_START' , 'DESKTOP_FLOW_FEEDBACK' , 'HUB_SYSTEMTRAY_QUIT_CONFIRM' , 'ASSESSMENT_END_MIRROR' , 'NOTIFICATION_LOADED' , 'FLOW_LIVE_AUTO_SWITCH' , 'HUB_EXPLORER_QUICKREAD_RESPONSE' , 'EXTENSION_GENERATION' , 'SELF_HELP_FEEDBACK_SEEN' , 'FLOW_LIVE_CLOSE' , 'BLOCKER_CLICKED' , 'APPHUB_TASKLIST_TODO_PILL_CLICKED' , 'HUB_APP_LOADED' , 'TIP_VALIDATE_ERROR' , 'SELF_HELP_CLOSE' , 'APPHUB_TOP_NAV_TASKLIST' , 'SELF_HELP_LOADED' , 'SURVEY_LOADED' , 'HUB_EXPLORER_QUICKREAD_LINKS' , 'HUB_EXPLORER_SEARCH' , 'SURVEY_MINIMIZE' , 'POPUP_CLOSE' , 'BADGE_CLICKED' , 'HUB_PIN_ICON_CLICK' , 'HUB_TASKS_LOADED' , 'SURVEY_SUBMIT' , 'HUB_TOP_NAV_TASKS' , 'FLOW_LIVE_COMPLETE' , 'FLOW_VIEW_END' , 'HUB_TOP_NAV_NOTIFICATIONS_CLICK' , 'HUB_PIN_NOTIFICATIONS_CLICK' , 'APPHUB_EXPLORER_QUICKREAD_LINKS' , 'CUE_SNOOZED' , 'APPHUB_PIN_FEEDBACK_CLICK' , 'HUB_PIN_FEEDBACK_CLICK' , 'FLOW_LIVE_CHANGE' , 'APPHUB_END_USER_FEEDBACK' , 'DESKTOPWALLPAPER_SHOWN' , 'QUICKREAD_RESPONSE' , 'APPHUB_TASKLIST_ALL_PILL_OPEN' , 'APPHUB_PIN_CHATBOT_CLICK' , 'hub_enduser_feedbacks add_to_stage' , 'FLOW_FEEDBACK' , 'HUB_TOP_NAV_CHATBOT' , 'search_feedbacks add_to_stage' , 'HUB_TASKBAR_CLICKED' , 'FLOW_CLOSURE_FEEDBACK' , 'BADGE_MOUSEOVER' , 'FLOW_LIVE_STOP' , 'HUB_NEW_POPUP_START_FLOW' , 'HUB_TASK_FILTER' , 'QUICKREAD_FEEDBACK' , 'FLOW_VIEW_CLOSE']) AND (category = 'whatfix')     )       AND toDate32(srm.chunk_start_ts, 'America/New_York') BETWEEN '2026-06-23' and '2026-06-29'     GROUP BY srm.session_id ) AS combined INNER JOIN (     SELECT argMax(resolved_user_id_value, created_at) AS resolved_user, related_id     FROM related_users_v7     PREWHERE ent_id = 'd96d0adf-4b0d-4458-9c13-9146ec6a35f1'     GROUP BY related_id ) AS ru ON combined.user_id = ru.related_id ORDER BY combined.start_time DESC LIMIT 50 OFFSET 0 SETTINGS asterisk_include_materialized_columns = 1