import { parseMedia } from '../shared/m3u8';
import { buildSegmentUrls, parseMpd } from '../shared/mpd';
import type { DownloadJob, JobPhase, JobProgress } from '../shared/types';
import { decryptSegment, importAesKey, parseIv } from './decrypt';
import { fetchAll, fetchBytes } from './fetcher';
import { muxAvToMp4, remuxToMp4 } from './ffmpeg';

const controllers = new Map<string, AbortController>();

// One ffmpeg instance + fixed FS filenames → jobs must not overlap. Serialize.
let jobChain: Promise<void> = Promise.resolve();

function enqueueJob(job: DownloadJob): void {
  const ac = new AbortController();
  controllers.set(job.jobId, ac); // registered now so CANCEL works while queued
  jobChain = jobChain.then(() => runJob(job, ac));
}

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

// --- HLS: fetch playlist → (decrypt) → concat into one elementary track ---
interface HlsTrack {
  bytes: Uint8Array;
  fmp4: boolean; // had an #EXT-X-MAP init segment (fMP4/CMAF) vs MPEG-TS
}

async function buildHlsTrack(
  job: DownloadJob,
  mediaPlaylistUrl: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<HlsTrack> {
  const res = await fetch(mediaPlaylistUrl, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`Manifest HTTP ${res.status}`);
  const media = parseMedia(await res.text(), mediaPlaylistUrl);

  if (!media.endlist) throw new Error('Live stream — not supported');
  if (media.encryption === 'unsupported-drm') throw new Error('DRM-protected — not supported');
  if (!media.segments.length) throw new Error('No segments found');

  let cryptoKey: CryptoKey | undefined;
  if (media.encryption === 'aes-128' && media.key?.uri) {
    report(job, 'key');
    cryptoKey = await importAesKey(await fetchBytes(media.key.uri, job.headers, signal));
  }

  const segBytes = await fetchAll(media.segments, job.headers, signal, onProgress);

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
  const fmp4 = !!media.initSegment;
  if (media.initSegment) {
    parts.push(
      await fetchBytes(media.initSegment.url, job.headers, signal, media.initSegment.byteRange),
    );
  }
  parts.push(...decrypted);
  return { bytes: concat(parts), fmp4 };
}

async function runHls(
  job: DownloadJob,
  mediaPlaylistUrl: string,
  audioPlaylistUrl: string | undefined,
  signal: AbortSignal,
): Promise<Uint8Array> {
  report(job, 'manifest', { percent: 1 });

  // Muxed audio (typical HLS): one track, single remux.
  if (!audioPlaylistUrl) {
    report(job, 'segments', { fetched: 0, percent: 5 });
    const v = await buildHlsTrack(job, mediaPlaylistUrl, signal, (done, total) =>
      report(job, 'segments', { fetched: done, total, percent: 5 + Math.round((done / total) * 70) }),
    );
    report(job, 'remux', { percent: 80 });
    return remuxToMp4(v.bytes, v.fmp4 ? 'input.mp4' : 'input.ts');
  }

  // Demuxed audio (e.g. X/Twitter): build video + audio tracks, then mux.
  // Progress: video 5..55, audio 55..78.
  report(job, 'segments', { fetched: 0, percent: 5 });
  const video = await buildHlsTrack(job, mediaPlaylistUrl, signal, (done, total) =>
    report(job, 'segments', { fetched: done, total, percent: 5 + Math.round((done / total) * 50) }),
  );
  const audio = await buildHlsTrack(job, audioPlaylistUrl, signal, (done, total) =>
    report(job, 'segments', { fetched: done, total, percent: 55 + Math.round((done / total) * 23) }),
  );
  report(job, 'remux', { percent: 80 });
  return muxAvToMp4(
    video.bytes,
    video.fmp4 ? 'video.mp4' : 'video.ts',
    audio.bytes,
    audio.fmp4 ? 'audio.mp4' : 'audio.ts',
  );
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
  // DASH SegmentTemplate yields whole-file segment URLs (no byte ranges).
  const segs = await fetchAll(mediaUrls.map((url) => ({ url })), job.headers, signal, onProgress);
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

async function runJob(job: DownloadJob, ac: AbortController): Promise<void> {
  const signal = ac.signal;

  try {
    const mp4 =
      job.source.type === 'hls'
        ? await runHls(job, job.source.mediaPlaylistUrl, job.source.audioPlaylistUrl, signal)
        : await runDash(job, job.source.mpdUrl, job.source.videoRepId, signal);

    report(job, 'saving', { percent: 95 });
    const url = URL.createObjectURL(new Blob([mp4 as BlobPart], { type: 'video/mp4' }));
    // Offscreen documents have no chrome.downloads API. Delegate the save to the
    // service worker, which can resolve our same-origin blob: URL. Await it so
    // the blob is consumed before we report 'done' (which lets the SW tear the
    // offscreen doc down and revoke the blob).
    const res = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_SAVE',
      jobId: job.jobId,
      url,
      filename: job.filename,
    })) as { ok?: boolean; error?: string } | undefined;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (!res?.ok) throw new Error(res?.error ?? 'download failed');

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
    enqueueJob(msg.job as DownloadJob);
  } else if (msg?.type === 'OFFSCREEN_CANCEL') {
    controllers.get(msg.jobId)?.abort();
  }
});

// Tell the SW we're listening — it withholds OFFSCREEN_START until this lands,
// otherwise a job sent right after createDocument() can arrive before this
// module has evaluated and be dropped.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => void 0);
