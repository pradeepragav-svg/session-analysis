import { useEffect, useRef, useState } from 'react';
import { Replayer } from 'rrweb';
import type { RRWebEvent } from '../types';

interface Props {
  events: RRWebEvent[];
  onCurrentTime: (ms: number) => void;
  seekToMs?: number;
}

function formatMs(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function RRWebPlayer({ events, onCurrentTime, seekToMs }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const replayerRef = useRef<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Keep a ref so the polling interval always calls the latest callback
  const onCurrentTimeRef = useRef(onCurrentTime);
  const playingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => { onCurrentTimeRef.current = onCurrentTime; }, [onCurrentTime]);

  useEffect(() => {
    if (!containerRef.current || events.length === 0) return;

    if (replayerRef.current) {
      try { replayerRef.current.pause(); } catch { /* ignore */ }
      containerRef.current.innerHTML = '';
    }
    if (pollRef.current) clearInterval(pollRef.current);

    // Find recorded viewport dimensions from the Meta event (type 4)
    const metaEvent = events.find((e) => e.type === 4);
    const recordedW = (metaEvent?.data as Record<string, number> | undefined)?.width ?? 1920;
    const recordedH = (metaEvent?.data as Record<string, number> | undefined)?.height ?? 1080;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replayer = new (Replayer as any)(events, {
      root: containerRef.current,
      speed: 1,
      skipInactive: false,
      showWarning: false,
      showDebug: false,
      UNSAFE_replayCanvas: false,
      // Block cross-origin sub-iframes — rrweb tries to access their contentDocument
      // which the browser blocks with "Unsafe attempt to load URL" errors.
      // Blocked iframes render as gray placeholders instead.
      blockSelector: 'iframe',
    });
    replayerRef.current = replayer;

    const meta = replayer.getMetaData();
    setTotalMs(meta.totalTime);
    setCurrentMs(0);
    playingRef.current = false;
    setPlaying(false);

    replayer.on('finish', () => {
      playingRef.current = false;
      setPlaying(false);
    });

    replayer.pause(0);

    // Scale the rrweb iframe to fit the container
    const scaleIframe = () => {
      const container = containerRef.current;
      const iframe = replayer.iframe as HTMLIFrameElement | undefined;
      if (!container || !iframe) return;
      const containerW = container.offsetWidth;
      if (!containerW) return;
      const scale = Math.min(containerW / recordedW, 560 / recordedH);
      iframe.style.transform = `scale(${scale})`;
      iframe.style.transformOrigin = 'top left';
      // Shrink the container to the visually scaled height so it doesn't leave a gap
      container.style.height = `${Math.round(recordedH * scale)}px`;
    };

    // Double rAF: first frame inserts the iframe, second frame has layout dimensions
    requestAnimationFrame(() => requestAnimationFrame(scaleIframe));

    const ro = new ResizeObserver(scaleIframe);
    ro.observe(containerRef.current);

    // Poll playback position every 100 ms — more reliable than the ui-update-current-time event
    pollRef.current = setInterval(() => {
      if (!replayerRef.current) return;
      try {
        const t: number = replayerRef.current.getCurrentTime?.() ?? 0;
        if (typeof t === 'number' && !isNaN(t) && t >= 0) {
          setCurrentMs(t);
          onCurrentTimeRef.current(t);
        }
      } catch { /* ignore */ }
    }, 100);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      ro.disconnect();
      try { replayer.pause(); } catch { /* ignore */ }
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [events]);

  useEffect(() => {
    if (seekToMs === undefined || !replayerRef.current) return;
    if (playingRef.current) {
      replayerRef.current.play(seekToMs);
    } else {
      replayerRef.current.pause(seekToMs);
    }
    setCurrentMs(seekToMs);
    onCurrentTimeRef.current(seekToMs);
  }, [seekToMs]);

  function handlePlayPause() {
    const r = replayerRef.current;
    if (!r) return;
    if (playing) {
      r.pause();
      playingRef.current = false;
      setPlaying(false);
    } else {
      r.play(currentMs);
      playingRef.current = true;
      setPlaying(true);
    }
  }

  function handleSpeedChange(s: number) {
    setSpeed(s);
    replayerRef.current?.setConfig({ speed: s });
  }

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const ms = Number(e.target.value);
    setCurrentMs(ms);
    onCurrentTimeRef.current(ms);
    if (replayerRef.current) {
      if (playingRef.current) {
        replayerRef.current.play(ms);
      } else {
        replayerRef.current.pause(ms);
      }
    }
  }

  if (events.length === 0) {
    return <div className="rrweb-wrapper"><div className="rrweb-placeholder">No events loaded</div></div>;
  }

  return (
    <div className="rrweb-wrapper">
      <div ref={containerRef} className="rrweb-container" />
      <div className="player-controls">
        <button className="ctrl-btn" onClick={handlePlayPause} title={playing ? 'Pause' : 'Play'}>
          {playing ? '⏸' : '▶'}
        </button>
        <span className="ctrl-time">{formatMs(currentMs)}</span>
        <input
          className="ctrl-scrub"
          type="range"
          min={0}
          max={totalMs}
          value={currentMs}
          onChange={handleScrub}
        />
        <span className="ctrl-time">{formatMs(totalMs)}</span>
        <div className="ctrl-speeds">
          {[0.5, 1, 2, 4].map((s) => (
            <button
              key={s}
              className={`speed-btn ${speed === s ? 'active' : ''}`}
              onClick={() => handleSpeedChange(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
