import { useEffect, useRef, useState } from 'react';
import type { Detection, JobProgress, Variant } from '../shared/types';
import { HoverPreview } from './HoverPreview';
import { thumbnailFor } from './thumbnail';

interface Props {
  detection: Detection;
  progress?: JobProgress;
  onDownload: (det: Detection, variant: Variant) => void;
  onCancel: (jobId: string) => void;
}

function variantLabel(v: Variant): string {
  if (v.height) return `${v.height}p`;
  if (v.resolution) return v.resolution;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)} kbps`;
  return 'default';
}

function fmtDuration(sec?: number): string {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtSize(det: Detection, v: Variant): string {
  if (!det.durationSec || !v.bandwidth) return '';
  const bytes = (det.durationSec * v.bandwidth) / 8;
  const mb = bytes / 1e6;
  return mb > 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${mb.toFixed(0)} MB`;
}

function fmtBytes(bytes: number): string {
  const mb = bytes / 1e6;
  return mb > 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);

export function StreamRow({ detection, progress, onDownload, onCancel }: Props) {
  const [thumb, setThumb] = useState<string | undefined>(detection.thumbnailDataUrl);
  const [hovered, setHovered] = useState(false);
  const [selected, setSelected] = useState(0); // variant index
  const jobIdRef = useRef<string | undefined>(progress?.jobId);
  if (progress?.jobId) jobIdRef.current = progress.jobId;

  useEffect(() => {
    if (thumb || !detection.supported) return;
    let cancelled = false;
    thumbnailFor(detection)
      .then((d) => d && !cancelled && setThumb(d))
      .catch(() => void 0);
    return () => {
      cancelled = true;
    };
  }, [detection.id, detection.supported]);

  const variant = detection.variants[selected] ?? detection.variants[0];
  const active = progress && !TERMINAL.has(progress.phase);
  // hls.js drives HLS preview; files play natively; DASH has no in-page preview.
  const canHoverPreview =
    detection.supported && (detection.kind === 'master' || detection.kind === 'media' || detection.kind === 'file');
  const kindLabel =
    detection.kind === 'dash' ? 'DASH' : detection.kind === 'file' ? 'FILE' : 'HLS';

  return (
    <div
      className={`row${detection.supported ? '' : ' row--disabled'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="thumb">
        {hovered && canHoverPreview ? (
          <HoverPreview
            variantUrl={variant?.url ?? detection.manifestUrl}
            native={detection.kind === 'file'}
          />
        ) : thumb ? (
          <img src={thumb} alt="" />
        ) : (
          <div className="thumb-placeholder">{detection.supported ? '🎬' : '⛔'}</div>
        )}
      </div>

      <div className="meta">
        <div className="title" title={detection.manifestUrl}>
          {detection.pageTitle || new URL(detection.manifestUrl).hostname}
        </div>
        <div className="sub">
          <span className="kind">{kindLabel}</span>
          {fmtDuration(detection.durationSec) ? ` · ${fmtDuration(detection.durationSec)}` : ''}
          {detection.bytes ? ` · ${fmtBytes(detection.bytes)}` : variant && fmtSize(detection, variant) ? ` · ${fmtSize(detection, variant)}` : ''}
          {detection.encryption === 'aes-128' ? ' · 🔒AES' : ''}
        </div>

        {!detection.supported ? (
          <div className="badge badge--off">{detection.unsupportedReason}</div>
        ) : active ? (
          <div className="progress">
            <div className="bar">
              <div className="bar-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <span className="phase">
              {progress?.phase}
              {progress?.phase === 'segments' && progress.total
                ? ` ${progress.fetched}/${progress.total}`
                : ''}
            </span>
            <button onClick={() => jobIdRef.current && onCancel(jobIdRef.current)}>✕</button>
          </div>
        ) : (
          <div className="actions">
            {detection.variants.length > 1 && (
              <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
                {detection.variants.map((v, i) => (
                  <option key={i} value={i}>
                    {variantLabel(v)}
                  </option>
                ))}
              </select>
            )}
            <button className="dl" onClick={() => onDownload(detection, variant)}>
              {progress?.phase === 'done'
                ? 'Download again'
                : detection.kind === 'file'
                  ? 'Download'
                  : 'Download MP4'}
            </button>
            {progress?.phase === 'error' && <span className="err">{progress.error}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
