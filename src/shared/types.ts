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
  url: string; // absolute media-playlist URL
  bandwidth: number; // bits/s
  resolution?: string; // "1920x1080"
  codecs?: string;
  height?: number; // parsed from resolution, for sorting/labels
}

export interface Detection {
  id: StreamId;
  tabId: number;
  manifestUrl: string;
  pageUrl: string;
  pageTitle: string;
  kind: 'master' | 'media';
  variants: Variant[]; // [single] for media-only
  durationSec?: number;
  encryption: Encryption;
  live: boolean;
  supported: boolean;
  unsupportedReason?: string;
  headers: CapturedHeaders;
  thumbnailDataUrl?: string;
  detectedAt: number;
}

export interface DownloadJob {
  jobId: string;
  detectionId: StreamId;
  mediaPlaylistUrl: string; // resolved chosen variant
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
