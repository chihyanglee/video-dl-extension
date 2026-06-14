import { useEffect, useRef, useState } from 'react';
import type { Detection, JobProgress, Variant } from '../shared/types';
import { HoverPreview } from './HoverPreview';
import { generateThumbnail } from './thumbnail';

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

const TERMINAL = new Set(['done', 'error', 'cancelled']);

export function StreamRow({ detection, progress, onDownload, onCancel }: Props) {
  const [thumb, setThumb] = useState<string | undefined>(detection.thumbnailDataUrl);
  const [hovered, setHovered] = useState(false);
  const [selected, setSelected] = useState(0); // variant index
  const jobIdRef = useRef<string | undefined>(progress?.jobId);
  if (progress?.jobId) jobIdRef.current = progress.jobId;

  useEffect(() => {
    if (thumb || !detection.supported) return;
    const variantUrl = detection.variants[0]?.url ?? detection.manifestUrl;
    let cancelled = false;
    generateThumbnail(detection.id, variantUrl)
      .then((d) => !cancelled && setThumb(d))
      .catch(() => void 0);
    return () => {
      cancelled = true;
    };
  }, [detection.id, detection.supported]);

  const variant = detection.variants[selected] ?? detection.variants[0];
  const active = progress && !TERMINAL.has(progress.phase);

  return (
    <div
      className={`row${detection.supported ? '' : ' row--disabled'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="thumb">
        {hovered && detection.supported ? (
          <HoverPreview variantUrl={variant?.url ?? detection.manifestUrl} />
        ) : thumb ? (
          <img src={thumb} alt="" />
        ) : (
          <div className="thumb-placeholder">{detection.supported ? '…' : '⛔'}</div>
        )}
      </div>

      <div className="meta">
        <div className="title" title={detection.manifestUrl}>
          {detection.pageTitle || new URL(detection.manifestUrl).hostname}
        </div>
        <div className="sub">
          {fmtDuration(detection.durationSec)}
          {variant && fmtSize(detection, variant) ? ` · ${fmtSize(detection, variant)}` : ''}
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
              {progress?.phase === 'done' ? 'Download again' : 'Download MP4'}
            </button>
            {progress?.phase === 'error' && <span className="err">{progress.error}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
