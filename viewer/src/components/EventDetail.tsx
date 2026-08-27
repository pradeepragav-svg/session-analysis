import type { WhatfixEvent, RRWebEvent } from '../types';

const RRWEB_EVENT_TYPES: Record<number, string> = {
  0: 'DomContentLoaded',
  1: 'Load',
  2: 'FullSnapshot',
  3: 'IncrementalSnapshot',
  4: 'Meta',
  5: 'Custom',
  6: 'Plugin',
};

const INCREMENTAL_SOURCES: Record<number, string> = {
  0: 'Mutation',
  1: 'MouseMove',
  2: 'MouseInteraction',
  3: 'Scroll',
  4: 'ViewportResize',
  5: 'Input',
  6: 'TouchMove',
  7: 'MediaInteraction',
  8: 'StyleSheetRule',
  9: 'CanvasMutation',
  10: 'Font',
  12: 'Drag',
  13: 'StyleDeclaration',
  14: 'Selection',
  15: 'AdoptedStyleSheet',
  16: 'CustomElement',
};

interface Props {
  selectedWhatfix: WhatfixEvent | null;
  nearestRRWeb: RRWebEvent | null;
}

function formatTs(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function rrwebLabel(event: RRWebEvent): string {
  const typeName = RRWEB_EVENT_TYPES[event.type] ?? `Type ${event.type}`;
  if (event.type === 3) {
    const src = (event.data as { source?: number }).source;
    if (src !== undefined) {
      return `${typeName} / ${INCREMENTAL_SOURCES[src] ?? `Source ${src}`}`;
    }
  }
  return typeName;
}

export function EventDetail({ selectedWhatfix, nearestRRWeb }: Props) {
  return (
    <div className="event-detail">
      {selectedWhatfix && (
        <section className="detail-section">
          <h3 className="detail-header whatfix-header">Whatfix Event</h3>
          <div className="detail-meta">
            <span className="detail-name">{selectedWhatfix.eventName}</span>
            <span className="detail-ts">{formatTs(selectedWhatfix.timestamp)}</span>
          </div>
          <div className="detail-key">{selectedWhatfix.eventKey}</div>
          <pre className="detail-json">{JSON.stringify(selectedWhatfix, null, 2)}</pre>
        </section>
      )}
      {nearestRRWeb && (
        <section className="detail-section">
          <h3 className="detail-header rrweb-header">
            RRWeb Event — {rrwebLabel(nearestRRWeb)}
          </h3>
          <div className="detail-meta">
            <span className="detail-ts">{formatTs(nearestRRWeb.timestamp)}</span>
          </div>
          <pre className="detail-json">{JSON.stringify(nearestRRWeb, null, 2)}</pre>
        </section>
      )}
      {!selectedWhatfix && !nearestRRWeb && (
        <div className="detail-empty">Click a marker on the timeline or play the session to inspect events.</div>
      )}
    </div>
  );
}
