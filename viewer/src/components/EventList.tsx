import { useState, useRef, useEffect, useMemo, Fragment } from 'react';
import type { EventCategory, UnifiedEvent } from '../utils/eventLabels';

const FILTERS: Array<{ id: EventCategory | 'all'; label: string; color: string }> = [
  { id: 'all',      label: 'All',      color: '#94a3b8' },
  { id: 'snapshot', label: 'Snapshot', color: '#94a3b8' },
  { id: 'mutation', label: 'Mutation', color: '#a78bfa' },
  { id: 'mouse',    label: 'Mouse',    color: '#60a5fa' },
  { id: 'scroll',   label: 'Scroll',   color: '#34d399' },
  { id: 'input',    label: 'Input',    color: '#fbbf24' },
  { id: 'whatfix',  label: 'Whatfix',  color: '#f97316' },
  { id: 'other',    label: 'Other',    color: '#64748b' },
];

const CAT_COLORS: Record<string, string> = {
  snapshot: '#94a3b8', mutation: '#a78bfa', mouse: '#60a5fa',
  scroll: '#34d399',   input: '#fbbf24',    whatfix: '#f97316', other: '#64748b',
};

const MAX_ROWS = 2000; // cap DOM rows for performance

interface Props {
  events: UnifiedEvent[];
  currentTimeMs: number;
  onSeek: (ms: number) => void;
}

function formatOffset(ms: number): string {
  const totalSec = Math.floor(Math.abs(ms) / 1000);
  const msec = Math.abs(ms) % 1000;
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const prefix = ms < 0 ? '-' : '';
  if (h > 0) return `${prefix}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msec).padStart(3, '0')}`;
  return `${prefix}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msec).padStart(3, '0')}`;
}

export function EventList({ events, currentTimeMs, onSeek }: Props) {
  const [filter, setFilter] = useState<EventCategory | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [followPlayback, setFollowPlayback] = useState(true);
  const currentRowRef = useRef<HTMLTableRowElement>(null);
  const lastScrolledIdxRef = useRef(-1);

  const filtered = useMemo(
    () => filter === 'all' ? events : events.filter(e => e.category === filter),
    [events, filter],
  );

  // Index of the event nearest to currentTimeMs in the filtered list
  const nearestIdx = useMemo(() => {
    if (filtered.length === 0) return -1;
    let best = 0;
    let bestDiff = Math.abs(filtered[0].offsetMs - currentTimeMs);
    for (let i = 1; i < filtered.length; i++) {
      const diff = Math.abs(filtered[i].offsetMs - currentTimeMs);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
      // Once we've passed currentTimeMs by more than bestDiff we can't improve
      if (filtered[i].offsetMs > currentTimeMs + bestDiff) break;
    }
    return best;
  }, [filtered, currentTimeMs]);

  // Window 2000 rows centered around nearestIdx to keep DOM size bounded
  const { windowEvents, windowOffset, isWindowed } = useMemo(() => {
    if (filtered.length <= MAX_ROWS) {
      return { windowEvents: filtered, windowOffset: 0, isWindowed: false };
    }
    const half = MAX_ROWS / 2;
    const start = Math.max(0, Math.min(nearestIdx - half, filtered.length - MAX_ROWS));
    const end = start + MAX_ROWS;
    return { windowEvents: filtered.slice(start, end), windowOffset: start, isWindowed: true };
  }, [filtered, nearestIdx]);

  const windowNearestIdx = nearestIdx - windowOffset;

  // Auto-scroll to current row when nearestIdx changes meaningfully
  useEffect(() => {
    if (!followPlayback) return;
    if (windowNearestIdx === lastScrolledIdxRef.current) return;
    lastScrolledIdxRef.current = windowNearestIdx;
    currentRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [windowNearestIdx, followPlayback]);

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: events.length };
    for (const e of events) m[e.category] = (m[e.category] ?? 0) + 1;
    return m;
  }, [events]);

  return (
    <div className="event-list">
      {/* Filter bar */}
      <div className="event-list-bar">
        <div className="event-filters">
          {FILTERS.map(f => (
            <button
              key={f.id}
              className={`event-filter-btn ${filter === f.id ? 'active' : ''}`}
              style={{ '--fc': f.color } as React.CSSProperties}
              onClick={() => setFilter(f.id as EventCategory | 'all')}
            >
              {f.label}
              <span className="event-filter-count">{(counts[f.id] ?? 0).toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className="event-list-meta">
          {isWindowed && (
            <span className="event-window-note">
              showing {windowOffset + 1}–{windowOffset + windowEvents.length} of {filtered.length.toLocaleString()}
            </span>
          )}
          <button
            className={`follow-btn ${followPlayback ? 'active' : ''}`}
            onClick={() => setFollowPlayback(v => !v)}
            title="Auto-scroll to current playback position"
          >
            {followPlayback ? '⏵ Following' : '⏸ Paused'}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="event-table-wrap">
        <table className="event-table">
          <thead>
            <tr>
              <th className="col-time">Time</th>
              <th className="col-type">Type</th>
              <th className="col-subtype">Sub-type</th>
              <th className="col-detail">Detail</th>
            </tr>
          </thead>
          <tbody>
            {windowEvents.map((evt, idx) => {
              const isCurrent = idx === windowNearestIdx;
              const isOpen = expanded === evt.id;
              return (
                <Fragment key={evt.id}>
                  <tr
                    ref={isCurrent ? currentRowRef : undefined}
                    className={`event-row${isCurrent ? ' current' : ''}${isOpen ? ' open' : ''}`}
                    onClick={() => {
                      onSeek(evt.offsetMs);
                      setExpanded(isOpen ? null : evt.id);
                    }}
                  >
                    <td className="col-time">{formatOffset(evt.offsetMs)}</td>
                    <td className="col-type">
                      <span
                        className="type-badge"
                        style={{
                          background: CAT_COLORS[evt.category] + '22',
                          color: CAT_COLORS[evt.category],
                          borderColor: CAT_COLORS[evt.category] + '55',
                        }}
                      >
                        {evt.type}
                      </span>
                    </td>
                    <td className="col-subtype">{evt.subtype}</td>
                    <td className="col-detail">{evt.detail}</td>
                  </tr>
                  {isOpen && (
                    <tr className="event-row-json">
                      <td colSpan={4}>
                        <pre className="event-json">{JSON.stringify(evt.raw, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
