export type StreamId = string; // hash(manifestUrl)

export type Encryption = 'none' | 'aes-128' | 'unsupported-drm';

export interface CapturedHeaders {
  referer?: string;
  origin?: string;
  userAgent?: string;
  cookie?: string;
  authorization?: string;
}

export interface Variant {
  url: string; // HLS: absolute media-playlist URL. DASH/file: source URL.
  bandwidth: number; // bits/s
  resolution?: string; // "1920x1080"
  codecs?: string;
  height?: number; // parsed from resolution, for sorting/labels
  repId?: string; // DASH Representation id (used to resolve segments at download)
}

export type DetectionKind = 'master' | 'media' | 'dash' | 'file';

export interface Detection {
  id: StreamId;
  tabId: number;
  manifestUrl: string; // HLS/DASH manifest URL, or the file URL for kind:'file'
  pageUrl: string;
  pageTitle: string;
  kind: DetectionKind;
  variants: Variant[]; // [single] for media-only / file
  durationSec?: number;
  bytes?: number; // known byte size (direct files, from Content-Length)
  encryption: Encryption;
  live: boolean;
  supported: boolean;
  unsupportedReason?: string;
  headers: CapturedHeaders;
  thumbnailDataUrl?: string;
  detectedAt: number;
}

// What to download, per source type. Files are handled outside the offscreen
// pipeline (direct chrome.downloads), so only HLS + DASH appear here.
export type JobSource =
  | { type: 'hls'; mediaPlaylistUrl: string }
  | { type: 'dash'; mpdUrl: string; videoRepId: string };

export interface DownloadJob {
  jobId: string;
  detectionId: StreamId;
  source: JobSource;
  headers: CapturedHeaders;
  filename: string;
}

export type JobPhase =
  | 'preparing' // ffmpeg loading
  | 'manifest'
  | 'key'
  | 'segments'
  | 'remux'
  | 'saving'
  | 'done'
  | 'error'
  | 'cancelled';

export interface JobProgress {
  jobId: string;
  detectionId: StreamId;
  phase: JobPhase;
  fetched?: number;
  total?: number;
  percent?: number; // 0..100 overall best-effort
  error?: string;
}
