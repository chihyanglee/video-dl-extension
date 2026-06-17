import { useEffect, useRef, useState } from 'react';
import type { Detection, JobProgress, Variant } from '../shared/types';
import { HoverPreview } from './HoverPreview';
import { thumbnailFor } from './thumbnail';
import { probe, fetchText, type ProbeResult } from './referer';

interface Props {
  detection: Detection;
  progress?: JobProgress;
  dev?: boolean;
  onDownload: (det: Detection, variant: Variant) => void;
  onCancel: (jobId: string) => void;
  onRename: (det: Detection, name: string) => void;
  onDismiss: (det: Detection) => void;
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

function defaultName(det: Detection): string {
  return det.customName ?? det.pageTitle ?? new URL(det.manifestUrl).hostname;
}

export function StreamRow({
  detection,
  progress,
  dev,
  onDownload,
  onCancel,
  onRename,
  onDismiss,
}: Props) {
  const [thumb, setThumb] = useState<string | undefined>(detection.thumbnailDataUrl);
  const [hovered, setHovered] = useState(false);
  const [selected, setSelected] = useState(0); // variant index
  const [name, setName] = useState(() => defaultName(detection));
  const jobIdRef = useRef<string | undefined>(progress?.jobId);
  if (progress?.jobId) jobIdRef.current = progress.jobId;
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [manifest, setManifest] = useState<ProbeResult | null>(null);
  const [devBusy, setDevBusy] = useState(false);

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
  // Output extension shown next to the editable name (files keep theirs; HLS/DASH → mp4).
  const outExt =
    detection.kind === 'file'
      ? (detection.manifestUrl.match(/\.(mp4|webm|mov|m4v|ogv|ogg)/i)?.[1] ?? 'mp4').toLowerCase()
      : 'mp4';

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(defaultName(detection)); // empty → revert
      return;
    }
    if (trimmed !== (detection.customName ?? detection.pageTitle)) {
      onRename(detection, trimmed);
    }
  };

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
        <div className="head">
          <input
            className="name"
            value={name}
            spellCheck={false}
            title={detection.manifestUrl}
            placeholder="filename"
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()} // select-all so a click replaces the name
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <span className="ext">.{outExt}</span>
          <button className="dismiss" title="Remove from list" onClick={() => onDismiss(detection)}>
            ✕
          </button>
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

        {dev && (
          <details className="dev" open>
            <summary>
              debug
              <button
                className="dev-copy"
                onClick={(e) => {
                  e.preventDefault();
                  navigator.clipboard.writeText(
                    JSON.stringify(
                      {
                        kind: detection.kind,
                        encryption: detection.encryption,
                        live: detection.live,
                        supported: detection.supported,
                        durationSec: detection.durationSec,
                        manifestUrl: detection.manifestUrl,
                        pageUrl: detection.pageUrl,
                        headers: detection.headers,
                        variants: detection.variants,
                      },
                      null,
                      2,
                    ),
                  );
                }}
              >
                Copy info
              </button>
            </summary>
            <div className="dev-row">
              <span className="dev-k">kind</span>
              <span className="dev-v">{detection.kind}</span>
            </div>
            <div className="dev-row">
              <span className="dev-k">enc</span>
              <span className="dev-v">{detection.encryption}{detection.live ? ' · live' : ''}</span>
            </div>
            <div className="dev-row">
              <span className="dev-k">url</span>
              <span className="dev-v dev-mono" onClick={() => navigator.clipboard.writeText(detection.manifestUrl)} title="Click to copy">
                {detection.manifestUrl}
              </span>
            </div>
            {detection.headers.referer && (
              <div className="dev-row">
                <span className="dev-k">referer</span>
                <span className="dev-v dev-mono">{detection.headers.referer}</span>
              </div>
            )}
            <div className="dev-row">
              <span className="dev-k">page</span>
              <span className="dev-v dev-mono">{detection.pageUrl}</span>
            </div>
            <div className="dev-row">
              <span className="dev-k">variants</span>
              <span className="dev-v dev-mono">
                {detection.variants
                  .map((v) => `${variantLabel(v)}${v.repId ? `[${v.repId}]` : ''} ${v.url}`)
                  .join('\n')}
              </span>
            </div>
            <div className="dev-row">
              <span className="dev-k">id</span>
              <span className="dev-v dev-mono">{detection.id}</span>
            </div>

            <div className="dev-actions">
              <button
                disabled={devBusy}
                onClick={async () => {
                  setDevBusy(true);
                  setProbeResult(await probe(detection.manifestUrl, detection.headers.referer ?? detection.pageUrl));
                  setDevBusy(false);
                }}
              >
                Probe
              </button>
              <button
                disabled={devBusy}
                onClick={async () => {
                  setDevBusy(true);
                  setManifest(await fetchText(detection.manifestUrl, detection.headers.referer ?? detection.pageUrl));
                  setDevBusy(false);
                }}
              >
                View manifest
              </button>
            </div>

            {probeResult && (
              <div className="dev-row">
                <span className="dev-k">probe</span>
                <span className="dev-v dev-mono">
                  {probeResult.error
                    ? `error: ${probeResult.error}`
                    : `HTTP ${probeResult.status} · ${probeResult.contentType || '(no content-type)'}`}
                </span>
              </div>
            )}
            {manifest && (
              <pre className="dev-manifest">
                {manifest.error
                  ? `error: ${manifest.error}`
                  : `HTTP ${manifest.status} · ${manifest.contentType}\n\n${manifest.text ?? ''}`}
              </pre>
            )}
          </details>
        )}
      </div>
    </div>
  );
}
