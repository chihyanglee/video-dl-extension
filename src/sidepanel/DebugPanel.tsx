import { useState } from 'react';
import type { Detection, Variant } from '../shared/types';
import { probe, fetchText, type ProbeResult } from './referer';

function variantLine(v: Variant): string {
  const label = v.height ? `${v.height}p` : v.resolution || (v.bandwidth ? `${Math.round(v.bandwidth / 1000)}kbps` : 'default');
  return `${label}${v.repId ? `[${v.repId}]` : ''} ${v.url}`;
}

/** Dev-only inspector: identity, captured headers, live probe + manifest viewer. */
export function DebugPanel({ detection }: { detection: Detection }) {
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [manifest, setManifest] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const referer = detection.headers.referer ?? detection.pageUrl;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const copyInfo = () =>
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

  return (
    <details className="dev" open>
      <summary>
        debug
        <button className="dev-copy" onClick={(e) => { e.preventDefault(); copyInfo(); }}>
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
        <span
          className="dev-v dev-mono"
          title="Click to copy"
          onClick={() => navigator.clipboard.writeText(detection.manifestUrl)}
        >
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
        <span className="dev-v dev-mono">{detection.variants.map(variantLine).join('\n')}</span>
      </div>
      <div className="dev-row">
        <span className="dev-k">id</span>
        <span className="dev-v dev-mono">{detection.id}</span>
      </div>

      <div className="dev-actions">
        <button
          disabled={busy}
          onClick={() => run(async () => setProbeResult(await probe(detection.manifestUrl, referer)))}
        >
          Probe
        </button>
        <button
          disabled={busy}
          onClick={() => run(async () => setManifest(await fetchText(detection.manifestUrl, referer)))}
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
  );
}
