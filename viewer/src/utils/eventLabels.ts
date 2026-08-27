import type { RRWebEvent, WhatfixEvent } from '../types';

export const INCREMENTAL_SOURCES: Record<number, string> = {
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

export const MOUSE_INTERACTIONS: Record<number, string> = {
  0: 'MouseUp',
  1: 'MouseDown',
  2: 'Click',
  3: 'ContextMenu',
  4: 'DblClick',
  5: 'Focus',
  6: 'Blur',
  7: 'TouchStart',
  8: 'TouchMove_Departed',
  9: 'TouchEnd',
  10: 'TouchCancel',
};

export type EventCategory = 'snapshot' | 'mutation' | 'mouse' | 'scroll' | 'input' | 'whatfix' | 'other';

export interface UnifiedEvent {
  id: string;
  offsetMs: number;
  category: EventCategory;
  type: string;
  subtype: string;
  detail: string;
  raw: RRWebEvent | WhatfixEvent;
}

export function classifyRRWeb(event: RRWebEvent, startTs: number, index: number): UnifiedEvent {
  const offsetMs = event.timestamp - startTs;
  const id = `rr-${index}`;
  const d = event.data as Record<string, unknown>;

  switch (event.type) {
    case 2:
      return { id, offsetMs, category: 'snapshot', type: 'FullSnapshot', subtype: '', detail: '', raw: event };
    case 3: {
      const src = (d.source as number) ?? -1;

      if (src === 0) {
        const adds = (d.adds as unknown[] | undefined)?.length ?? 0;
        const removes = (d.removes as unknown[] | undefined)?.length ?? 0;
        const attribs = (d.attributes as unknown[] | undefined)?.length ?? 0;
        const texts = (d.texts as unknown[] | undefined)?.length ?? 0;
        const parts: string[] = [];
        if (adds) parts.push(`+${adds} nodes`);
        if (removes) parts.push(`-${removes} nodes`);
        if (attribs) parts.push(`${attribs} attrs`);
        if (texts) parts.push(`${texts} texts`);
        return { id, offsetMs, category: 'mutation', type: 'Mutation', subtype: '', detail: parts.join(', '), raw: event };
      }
      if (src === 1 || src === 6) {
        const pts = (d.positions as unknown[] | undefined)?.length ?? 0;
        return { id, offsetMs, category: 'mouse', type: 'MouseMove', subtype: src === 6 ? 'Touch' : '', detail: pts ? `${pts} pts` : '', raw: event };
      }
      if (src === 2) {
        const iType = (d.type as number) ?? -1;
        const interaction = MOUSE_INTERACTIONS[iType] ?? `Type(${iType})`;
        const nodeId = d.id as number | undefined;
        return { id, offsetMs, category: 'mouse', type: 'MouseInteraction', subtype: interaction, detail: nodeId !== undefined ? `node #${nodeId}` : '', raw: event };
      }
      if (src === 3) {
        const x = d.x as number | undefined;
        const y = d.y as number | undefined;
        return { id, offsetMs, category: 'scroll', type: 'Scroll', subtype: '', detail: x !== undefined ? `${x}, ${y}` : '', raw: event };
      }
      if (src === 5) {
        const val = String(d.text ?? '');
        return { id, offsetMs, category: 'input', type: 'Input', subtype: '', detail: val.length > 50 ? val.slice(0, 50) + '…' : val, raw: event };
      }
      const srcName = INCREMENTAL_SOURCES[src] ?? `Source(${src})`;
      return { id, offsetMs, category: 'other', type: 'Incremental', subtype: srcName, detail: '', raw: event };
    }
    case 4:
      return { id, offsetMs, category: 'other', type: 'Meta', subtype: '', detail: String(d.href ?? ''), raw: event };
    case 5:
      return { id, offsetMs, category: 'other', type: 'Custom', subtype: String(d.tag ?? ''), detail: '', raw: event };
    default:
      return { id, offsetMs, category: 'other', type: `Type(${event.type})`, subtype: '', detail: '', raw: event };
  }
}

export function classifyWhatfix(event: WhatfixEvent, startTs: number, index: number): UnifiedEvent {
  return {
    id: `wf-${index}`,
    offsetMs: event.timestamp - startTs,
    category: 'whatfix',
    type: 'Whatfix',
    subtype: event.eventName,
    detail: event.eventKey,
    raw: event,
  };
}

export function buildUnifiedEvents(
  rrwebEvents: RRWebEvent[],
  whatfixEvents: WhatfixEvent[],
  startTs: number,
): UnifiedEvent[] {
  const rr = rrwebEvents.map((e, i) => classifyRRWeb(e, startTs, i));
  const wf = whatfixEvents.map((e, i) => classifyWhatfix(e, startTs, i));
  return [...rr, ...wf].sort((a, b) => a.offsetMs - b.offsetMs);
}
