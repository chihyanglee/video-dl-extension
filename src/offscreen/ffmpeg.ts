import { FFmpeg } from '@ffmpeg/ffmpeg';

// Single-threaded core is shipped as extension-origin assets under public/
// (MV3 CSP forbids loading wasm/JS from a remote CDN). Single-thread core needs
// no SharedArrayBuffer / COOP-COEP. Resolved at runtime via getURL.
const coreURL = chrome.runtime.getURL('ffmpeg-core/ffmpeg-core.js');
const wasmURL = chrome.runtime.getURL('ffmpeg-core/ffmpeg-core.wasm');

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<boolean> | null = null;

export function isLoaded(): boolean {
  return ffmpeg?.loaded ?? false;
}

export async function ensureFfmpeg(onLog?: (line: string) => void): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (!ffmpeg) {
    ffmpeg = new FFmpeg();
    if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
  }
  if (!loadPromise) {
    loadPromise = ffmpeg.load({ coreURL, wasmURL });
  }
  await loadPromise;
  return ffmpeg;
}

/**
 * Remux a single concatenated elementary stream (TS or fMP4) to MP4 without
 * re-encoding. `inputName` extension hints the demuxer (e.g. input.ts / input.mp4).
 */
export async function remuxToMp4(
  input: Uint8Array,
  inputName: string,
): Promise<Uint8Array> {
  const ff = await ensureFfmpeg();
  const outName = 'out.mp4';
  await ff.writeFile(inputName, input);
  await ff.exec([
    '-i',
    inputName,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outName,
  ]);
  const data = (await ff.readFile(outName)) as Uint8Array;
  // Clean FS to free memory for the next job.
  await ff.deleteFile(inputName).catch(() => void 0);
  await ff.deleteFile(outName).catch(() => void 0);
  return data;
}

/**
 * Mux separate video and audio elementary streams into one MP4 without
 * re-encoding (DASH delivers video and audio as distinct representations).
 */
export async function muxAvToMp4(
  video: Uint8Array,
  videoName: string,
  audio: Uint8Array,
  audioName: string,
): Promise<Uint8Array> {
  const ff = await ensureFfmpeg();
  const outName = 'out.mp4';
  await ff.writeFile(videoName, video);
  await ff.writeFile(audioName, audio);
  await ff.exec([
    '-i',
    videoName,
    '-i',
    audioName,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outName,
  ]);
  const data = (await ff.readFile(outName)) as Uint8Array;
  await ff.deleteFile(videoName).catch(() => void 0);
  await ff.deleteFile(audioName).catch(() => void 0);
  await ff.deleteFile(outName).catch(() => void 0);
  return data;
}

export function terminate(): void {
  try {
    ffmpeg?.terminate();
  } catch {
    /* ignore */
  }
  ffmpeg = null;
  loadPromise = null;
}
