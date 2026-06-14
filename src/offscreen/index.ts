import { parseMedia } from '../shared/m3u8';
import type { DownloadJob, JobPhase, JobProgress } from '../shared/types';
import { decryptSegment, importAesKey, parseIv } from './decrypt';
import { fetchAll, fetchBytes } from './fetcher';
import { remuxToMp4 } from './ffmpeg';

const controllers = new Map<string, AbortController>();

function report(job: DownloadJob, phase: JobPhase, extra: Partial<JobProgress> = {}): void {
  const progress: JobProgress = {
    jobId: job.jobId,
    detectionId: job.detectionId,
    phase,
    ...extra,
  };
  chrome.runtime.sendMessage({ type: 'JOB_PROGRESS', progress }).catch(() => void 0);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function runJob(job: DownloadJob): Promise<void> {
  const ac = new AbortController();
  controllers.set(job.jobId, ac);
  const signal = ac.signal;

  try {
    report(job, 'manifest', { percent: 1 });
    const res = await fetch(job.mediaPlaylistUrl, { credentials: 'include', signal });
    if (!res.ok) throw new Error(`Manifest HTTP ${res.status}`);
    const text = await res.text();
    const media = parseMedia(text, job.mediaPlaylistUrl);

    if (!media.endlist) throw new Error('Live stream — not supported');
    if (media.encryption === 'unsupported-drm') throw new Error('DRM-protected — not supported');
    if (!media.segments.length) throw new Error('No segments found');

    // AES-128 key (if encrypted).
    let cryptoKey: CryptoKey | undefined;
    if (media.encryption === 'aes-128' && media.key?.uri) {
      report(job, 'key', { percent: 3 });
      const keyBytes = await fetchBytes(media.key.uri, job.headers, signal);
      cryptoKey = await importAesKey(keyBytes);
    }

    // Fetch segments (+ optional init segment).
    report(job, 'segments', { fetched: 0, total: media.segments.length, percent: 5 });
    const segBytes = await fetchAll(media.segments, job.headers, signal, (done, total) => {
      report(job, 'segments', {
        fetched: done,
        total,
        percent: 5 + Math.round((done / total) * 70), // 5..75
      });
    });

    // Decrypt if needed (AES-128-CBC; IV explicit or sequence-derived).
    let decrypted = segBytes;
    if (cryptoKey) {
      decrypted = [];
      for (let i = 0; i < segBytes.length; i++) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        const iv = parseIv(media.key!.iv, media.mediaSequence + i);
        decrypted.push(await decryptSegment(cryptoKey, iv, segBytes[i]));
      }
    }

    // Concat: init segment (fMP4) + media segments.
    const parts: Uint8Array[] = [];
    let isFmp4 = false;
    if (media.initSegment) {
      isFmp4 = true;
      parts.push(await fetchBytes(media.initSegment, job.headers, signal));
    }
    parts.push(...decrypted);
    const input = concat(parts);

    report(job, 'remux', { percent: 80 });
    const inputName = isFmp4 ? 'input.mp4' : 'input.ts';
    const mp4 = await remuxToMp4(input, inputName);

    report(job, 'saving', { percent: 95 });
    const blob = new Blob([mp4 as BlobPart], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: job.filename, saveAs: false });
    // Revoke shortly after to let the download start reading.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    report(job, 'done', { percent: 100 });
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    report(job, aborted ? 'cancelled' : 'error', { error: aborted ? undefined : String(e) });
  } finally {
    controllers.delete(job.jobId);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'OFFSCREEN_START') {
    void runJob(msg.job as DownloadJob);
  } else if (msg?.type === 'OFFSCREEN_CANCEL') {
    controllers.get(msg.jobId)?.abort();
  }
});
