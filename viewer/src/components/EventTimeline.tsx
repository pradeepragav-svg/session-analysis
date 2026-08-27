import { useRef, useEffect, useCallback } from 'react';
import type { EventCategory, UnifiedEvent } from '../utils/eventLabels';

const LANES: Array<{ id: EventCategory; label: string; color: string }> = [
  { id: 'snapshot', label: 'Snapshot', color: '#94a3b8' },
  { id: 'mutation', label: 'Mutation',  color: '#a78bfa' },
  { id: 'mouse',    label: 'Mouse',     color: '#60a5fa' },
  { id: 'scroll',   label: 'Scroll',    color: '#34d399' },
  { id: 'input',    label: 'Input',     color: '#fbbf24' },
  { id: 'whatfix',  label: 'Whatfix',   color: '#f97316' },
  { id: 'other',    label: 'Other',     color: '#64748b' },
];

const LANE_H = 24;
const LABEL_W = 72;
const COUNT_W = 52;
const PAD = 4;
const IDLE_THRESHOLD_MS = 5_000; // gaps longer than 5s are shown as idle

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}

interface IdleRegion { startMs: number; endMs: number; }

function computeIdleRegions(events: UnifiedEvent[]): IdleRegion[] {
  if (events.length < 2) return [];
  const sorted = [...events].sort((a, b) => a.offsetMs - b.offsetMs);
  const regions: IdleRegion[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].offsetMs - sorted[i - 1].offsetMs;
    if (gap > IDLE_THRESHOLD_MS) {
      regions.push({ startMs: sorted[i - 1].offsetMs, endMs: sorted[i].offsetMs });
    }
  }
  return regions;
}

interface Props {
  events: UnifiedEvent[];
  duration: number;
  currentTimeMs: number;
  onSeek: (ms: number) => void;
}

export function EventTimeline({ events, duration, currentTimeMs, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const totalH = LANES.length * LANE_H + PAD * 2 + 14; // +14 for time axis

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || duration <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.offsetWidth;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${totalH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(totalH * dpr);

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const trackW = Math.max(1, cssW - LABEL_W - COUNT_W - 8);

    ctx.fillStyle = '#0e111a';
    ctx.fillRect(0, 0, cssW, totalH);

    const idleRegions = computeIdleRegions(events);

    LANES.forEach((lane, i) => {
      const y = PAD + i * LANE_H;
      const laneEvents = events.filter(e => e.category === lane.id);

      ctx.fillStyle = i % 2 === 0 ? '#12151f' : '#0e111a';
      ctx.fillRect(0, y, cssW, LANE_H);

      // Label
      ctx.font = '10px ui-monospace, "Cascadia Code", monospace';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = lane.color;
      ctx.fillText(lane.label, 6, y + LANE_H / 2);

      // Track background
      ctx.fillStyle = '#080b12';
      ctx.fillRect(LABEL_W, y + 4, trackW, LANE_H - 8);

      // Idle regions — dim overlay across the track
      for (const region of idleRegions) {
        const x0 = Math.round((region.startMs / duration) * (trackW - 1));
        const x1 = Math.round((region.endMs / duration) * (trackW - 1));
        const rx = LABEL_W + x0;
        const rw = Math.max(1, x1 - x0);
        // Subtle hatched fill
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(rx, y + 4, rw, LANE_H - 8);
        // Left/right border ticks
        ctx.fillStyle = 'rgba(100,116,139,0.25)';
        ctx.fillRect(rx, y + 4, 1, LANE_H - 8);
        ctx.fillRect(rx + rw - 1, y + 4, 1, LANE_H - 8);
      }

      // Event ticks bucketed to pixel columns (avoids drawing 19k marks)
      const cols = new Set<number>();
      for (const e of laneEvents) {
        const px = Math.round((e.offsetMs / duration) * (trackW - 1));
        cols.add(Math.max(0, Math.min(trackW - 1, px)));
      }
      ctx.fillStyle = lane.color;
      for (const col of cols) {
        ctx.fillRect(LABEL_W + col, y + LANE_H / 2 - 2, 1, 5);
      }

      // Count
      ctx.fillStyle = '#334155';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(laneEvents.length.toLocaleString(), cssW - 4, y + LANE_H / 2);
      ctx.textAlign = 'left';
    });

    // Draw idle labels spanning all lanes (after lane drawing so they appear on top)
    const lanesTop = PAD;
    const lanesBottom = PAD + LANES.length * LANE_H;
    for (const region of idleRegions) {
      const x0 = Math.round((region.startMs / duration) * (trackW - 1));
      const x1 = Math.round((region.endMs / duration) * (trackW - 1));
      const rx = LABEL_W + x0;
      const rw = Math.max(1, x1 - x0);
      const cx = rx + rw / 2;

      // Dashed vertical borders
      ctx.strokeStyle = 'rgba(100,116,139,0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(rx, lanesTop); ctx.lineTo(rx, lanesBottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx + rw, lanesTop); ctx.lineTo(rx + rw, lanesBottom); ctx.stroke();
      ctx.setLineDash([]);

      // Label pill if the gap is wide enough to fit text
      const label = `⏸ idle ${formatDuration(region.endMs - region.startMs)}`;
      ctx.font = 'bold 9px ui-monospace, monospace';
      const textW = ctx.measureText(label).width;
      const pillW = textW + 10;
      const pillH = 14;
      const pillY = lanesTop + (lanesBottom - lanesTop) / 2 - pillH / 2;

      if (rw > pillW + 4) {
        ctx.fillStyle = 'rgba(15,17,26,0.85)';
        ctx.beginPath();
        ctx.roundRect(cx - pillW / 2, pillY, pillW, pillH, 3);
        ctx.fill();
        ctx.fillStyle = '#475569';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, pillY + pillH / 2);
        ctx.textAlign = 'left';
      }
    }

    // Time axis
    const axisY = PAD + LANES.length * LANE_H + 10;
    ctx.fillStyle = '#334155';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('0s', LABEL_W, axisY);
    ctx.textAlign = 'right';
    ctx.fillText(`${(duration / 1000).toFixed(0)}s`, LABEL_W + trackW, axisY);
    // Mid tick
    const midLabel = `${(duration / 2000).toFixed(0)}s`;
    ctx.textAlign = 'center';
    ctx.fillText(midLabel, LABEL_W + trackW / 2, axisY);
    ctx.textAlign = 'left';

    // Playhead
    const ph = LABEL_W + (currentTimeMs / duration) * trackW;
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ph, PAD);
    ctx.lineTo(ph, PAD + LANES.length * LANE_H);
    ctx.stroke();

    ctx.fillStyle = '#6366f1';
    ctx.beginPath();
    ctx.moveTo(ph - 4, PAD);
    ctx.lineTo(ph + 4, PAD);
    ctx.lineTo(ph, PAD + 7);
    ctx.closePath();
    ctx.fill();
  }, [events, duration, currentTimeMs, totalH]);

  useEffect(() => { render(); }, [render]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [render]);

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const trackW = rect.width - LABEL_W - COUNT_W - 8;
    if (x < LABEL_W || x > LABEL_W + trackW) return;
    onSeek(Math.round(((x - LABEL_W) / trackW) * duration));
  }

  return (
    <div ref={wrapRef} className="swim-lanes-wrap">
      <canvas ref={canvasRef} onClick={handleClick} className="swim-lanes-canvas" />
    </div>
  );
}
