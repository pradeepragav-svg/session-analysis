export interface IndexEntry {
  timestamp: number;
  type: 'start' | 'snapshot' | 'end';
}

export interface IndexResponse {
  result: string;
  detail: {
    entries: IndexEntry[];
    metadata?: { columnNames: string[] };
  };
}

export interface WhatfixEvent {
  eventKey: string;
  eventName: string;
  timestamp: number;
}

export interface WhatfixEventsResponse {
  result: string;
  detail: {
    entId: string;
    sessionId: string;
    events: WhatfixEvent[];
  };
}

export interface RRWebEventRow {
  hitId: string;
  userId: string;
  eventTimestamp: number;
  eventSeqNo: number;
  eventType: number;
  pageUrl: string;
  eventData: string;
  properties?: string;
}

export interface RRWebChunkResponse {
  result: string;
  detail: {
    entId: string;
    sessionId: string;
    events: RRWebEventRow[];
  };
}

export interface RRWebEvent {
  type: number;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface SessionConfig {
  entId: string;
  sessionId: string;
  cookie: string;
  timezone: string;
}

export interface LoadedSession {
  config: SessionConfig;
  indexEntries: IndexEntry[];
  rrwebEvents: RRWebEvent[];
  whatfixEvents: WhatfixEvent[];
  startTs: number;
  endTs: number;
}
