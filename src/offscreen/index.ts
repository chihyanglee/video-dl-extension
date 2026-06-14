import { parseMedia } from '../shared/m3u8';
import { buildSegmentUrls, parseMpd } from '../shared/mpd';
import type { DownloadJob, JobPhase, JobProgress } from '../shared/types';
import { decryptSegment, importAesKey, parseIv } from './decrypt';
import { fetchAll, fetchBytes } from './fetcher';
import { muxAvToMp4, remuxToMp4 } from './ffmpeg';

const controllers = new Map<string, AbortController>();

function report(job: DownloadJob, phase: JobPhase, extra: Partial<JobProgress> = {}): void {
  const progress: JobProgress = { jobId: job.jobId, detectionId: job.detectionId, phase, ...extra };
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

// --- HLS: fetch playlist → (decrypt) → concat → remux ---
async function runHls(
  job: DownloadJob,
  mediaPlaylistUrl: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  report(job, 'manifest', { percent: 1 });
  const res = await fetch(mediaPlaylistUrl, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`Manifest HTTP ${res.status}`);
  const media = parseMedia(await res.text(), mediaPlaylistUrl);

  if (!media.endlist) throw new Error('Live stream — not supported');
  if (media.encryption === 'unsupported-drm') throw new Error('DRM-protected — not supported');
  if (!media.segments.length) throw new Error('No segments found');

  let cryptoKey: CryptoKey | undefined;
  if (media.encryption === 'aes-128' && media.key?.uri) {
    report(job, 'key', { percent: 3 });
    cryptoKey = await importAesKey(await fetchBytes(media.key.uri, job.headers, signal));
  }

  report(job, 'segments', { fetched: 0, total: media.segments.length, percent: 5 });
  const segBytes = await fetchAll(media.segments, job.headers, signal, (done, total) =>
    report(job, 'segments', { fetched: done, total, percent: 5 + Math.round((done / total) * 70) }),
  );

  let decrypted = segBytes;
  if (cryptoKey) {
    decrypted = [];
    for (let i = 0; i < segBytes.length; i++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const iv = parseIv(media.key!.iv, media.mediaSequence + i);
      decrypted.push(await decryptSegment(cryptoKey, iv, segBytes[i]));
    }
  }

  const parts: Uint8Array[] = [];
  let isFmp4 = false;
  if (media.initSegment) {
    isFmp4 = true;
    parts.push(await fetchBytes(media.initSegment, job.headers, signal));
  }
  parts.push(...decrypted);

  report(job, 'remux', { percent: 80 });
  return remuxToMp4(concat(parts), isFmp4 ? 'input.mp4' : 'input.ts');
}

// --- DASH: parse MPD → fetch video+audio tracks → mux ---
async function fetchTrack(
  job: DownloadJob,
  initUrl: string | undefined,
  mediaUrls: string[],
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  if (initUrl) parts.push(await fetchBytes(initUrl, job.headers, signal));
  const segs = await fetchAll(mediaUrls, job.headers, signal, onProgress);
  parts.push(...segs);
  return concat(parts);
}

async function runDash(
  job: DownloadJob,
  mpdUrl: string,
  videoRepId: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  report(job, 'manifest', { percent: 1 });
  const res = await fetch(mpdUrl, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`MPD HTTP ${res.status}`);
  const mpd = parseMpd(await res.text(), mpdUrl);
  if (!mpd.supported) throw new Error(mpd.reason ?? 'Unsupported DASH');

  const video = mpd.video.find((r) => r.id === videoRepId) ?? mpd.video[0];
  if (!video) throw new Error('No video representation');
  const audio = mpd.audio[0]; // best audio (sorted highest bandwidth)

  const v = buildSegmentUrls(video, mpd.durationSec);
  if (!v.mediaUrls.length) throw new Error('No video segments resolved');
  const a = audio ? buildSegmentUrls(audio, mpd.durationSec) : undefined;

  // Progress spans both tracks: video 5..50, audio 50..75.
  const vTotal = v.mediaUrls.length;
  const aTotal = a?.mediaUrls.length ?? 0;
  report(job, 'segments', { fetched: 0, total: vTotal + aTotal, percent: 5 });

  const videoBytes = await fetchTrack(job, v.initUrl, v.mediaUrls, signal, (done) =>
    report(job, 'segments', {
      fetched: done,
      total: vTotal + aTotal,
      percent: 5 + Math.round((done / vTotal) * 45),
    }),
  );

  report(job, 'remux', { percent: 80 });
  if (!a) {
    // Video-only DASH → remux single track.
    return remuxToMp4(videoBytes, 'input.mp4');
  }

  const audioBytes = await fetchTrack(job, a.initUrl, a.mediaUrls, signal, (done) =>
    report(job, 'segments', {
      fetched: vTotal + done,
      total: vTotal + aTotal,
      percent: 50 + Math.round((done / aTotal) * 25),
    }),
  );

  report(job, 'remux', { percent: 80 });
  return muxAvToMp4(videoBytes, 'video.mp4', audioBytes, 'audio.mp4');
}

async function runJob(job: DownloadJob): Promise<void> {
  const ac = new AbortController();
  controllers.set(job.jobId, ac);
  const signal = ac.signal;

  try {
    const mp4 =
      job.source.type === 'hls'
        ? await runHls(job, job.source.mediaPlaylistUrl, signal)
        : await runDash(job, job.source.mpdUrl, job.source.videoRepId, signal);

    report(job, 'saving', { percent: 95 });
    const url = URL.createObjectURL(new Blob([mp4 as BlobPart], { type: 'video/mp4' }));
    await chrome.downloads.download({ url, filename: job.filename, saveAs: false });
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
