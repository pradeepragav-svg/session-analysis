import type {
  IndexResponse,
  WhatfixEventsResponse,
  RRWebChunkResponse,
  IndexEntry,
  WhatfixEvent,
  RRWebEvent,
  SessionConfig,
} from '../types';
import { decodeEventData } from './decoder';

const BASE = '/api';

function headers(cookie: string): HeadersInit {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-forwarded-cookie': cookie,
  };
}

export async function fetchIndex(config: SessionConfig): Promise<IndexEntry[]> {
  const { entId, sessionId, cookie } = config;
  const res = await fetch(
    `${BASE}/session_replay/${entId}/index?sessionId=${sessionId}`,
    { headers: headers(cookie) }
  );
  if (!res.ok) throw new Error(`Index fetch failed: ${res.status}`);
  const data: IndexResponse = await res.json();
  return data.detail.entries;
}

export async function fetchWhatfixEvents(config: SessionConfig): Promise<WhatfixEvent[]> {
  const { entId, sessionId, cookie, timezone } = config;
  const res = await fetch(
    `${BASE}/session_replay/${entId}/session/${sessionId}/events`,
    {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify({ data: { timezone }, withCredentials: false }),
    }
  );
  if (!res.ok) throw new Error(`Whatfix events fetch failed: ${res.status}`);
  const data: WhatfixEventsResponse = await res.json();
  return data.detail.events ?? [];
}

export async function fetchRRWebChunk(
  config: SessionConfig,
  startTs: number,
  endTs: number
): Promise<RRWebEvent[]> {
  const { entId, sessionId, cookie } = config;
  const res = await fetch(
    `${BASE}/session_replay/${entId}/events?sessionId=${sessionId}&startTs=${startTs}&endTs=${endTs}`,
    { headers: headers(cookie) }
  );
  if (!res.ok) throw new Error(`RRWeb chunk fetch failed: ${res.status} [${startTs}-${endTs}]`);
  const data: RRWebChunkResponse = await res.json();
  return (data.detail.events ?? [])
    .map((row) => decodeEventData(row.eventData))
    .filter((e): e is RRWebEvent => e !== null);
}

export async function loadSession(
  config: SessionConfig,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ rrwebEvents: RRWebEvent[]; whatfixEvents: WhatfixEvent[]; indexEntries: IndexEntry[] }> {
  const [indexEntries, whatfixEvents] = await Promise.all([
    fetchIndex(config),
    fetchWhatfixEvents(config),
  ]);

  const timestamps = indexEntries.map((e) => e.timestamp);
  const windows: Array<[number, number]> = [];
  for (let i = 0; i < timestamps.length - 1; i++) {
    windows.push([timestamps[i], timestamps[i + 1]]);
  }

  const allEvents: RRWebEvent[] = [];
  for (let i = 0; i < windows.length; i++) {
    const [start, end] = windows[i];
    const chunk = await fetchRRWebChunk(config, start, end);
    allEvents.push(...chunk);
    onProgress?.(i + 1, windows.length);
  }

  allEvents.sort((a, b) => a.timestamp - b.timestamp);
  return { rrwebEvents: allEvents, whatfixEvents, indexEntries };
}
