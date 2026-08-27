import { useState, useCallback, useMemo } from 'react';
import type { LoadedSession } from '../types';
import { buildUnifiedEvents } from '../utils/eventLabels';
import { RRWebPlayer } from './RRWebPlayer';
import { EventTimeline } from './EventTimeline';
import { EventList } from './EventList';

interface Props {
  session: LoadedSession;
}

export function SessionViewer({ session }: Props) {
  const { config, rrwebEvents, whatfixEvents, indexEntries, startTs, endTs } = session;
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [seekToMs, setSeekToMs] = useState<number | undefined>(undefined);

  const duration = endTs - startTs;

  const unifiedEvents = useMemo(
    () => buildUnifiedEvents(rrwebEvents, whatfixEvents, startTs),
    [rrwebEvents, whatfixEvents, startTs],
  );

  const handleSeek = useCallback((offsetMs: number) => {
    setSeekToMs(offsetMs);
  }, []);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(rrwebEvents, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rrweb-events-${config.sessionId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [rrwebEvents, config.sessionId]);

  const snapshotCount = indexEntries.filter(e => e.type === 'snapshot').length;

  return (
    <div className="session-viewer">
      {/* Top row: player + stats */}
      <div className="viewer-top">
        <div className="viewer-player-wrap">
          <RRWebPlayer
            events={rrwebEvents}
            onCurrentTime={setCurrentTimeMs}
            seekToMs={seekToMs}
          />
        </div>
        <div className="viewer-stats-panel">
          <div className="stat-item">
            <span className="stat-value">{rrwebEvents.length.toLocaleString()}</span>
            <span className="stat-label">RRWeb events</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{whatfixEvents.length.toLocaleString()}</span>
            <span className="stat-label">Whatfix events</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{snapshotCount}</span>
            <span className="stat-label">Snapshots</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{(duration / 1000).toFixed(0)}s</span>
            <span className="stat-label">Duration</span>
          </div>
          <button
            type="button"
            className="export-button"
            onClick={handleExport}
            disabled={rrwebEvents.length === 0}
          >
            Export RRWeb events
          </button>
        </div>
      </div>

      {/* Swim-lane timeline */}
      <EventTimeline
        events={unifiedEvents}
        duration={duration}
        currentTimeMs={currentTimeMs}
        onSeek={handleSeek}
      />

      {/* Event inspector table */}
      <EventList
        events={unifiedEvents}
        currentTimeMs={currentTimeMs}
        onSeek={handleSeek}
      />
    </div>
  );
}
