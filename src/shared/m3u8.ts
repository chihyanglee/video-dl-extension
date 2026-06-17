import type { Encryption, Variant } from './types';

// Lightweight HLS (RFC 8216) parser — only what the MVP pipeline needs.

export function resolveUrl(base: string, ref: string): string {
  return new URL(ref, base).href;
}

/** Parse an attribute list like KEY=VAL,KEY="quoted,val" into a map. */
export function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match KEY=VALUE where VALUE is "quoted" or bare-until-comma.
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const key = m[1];
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export function isMaster(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF');
}

export interface MasterPlaylist {
  kind: 'master';
  variants: Variant[];
}

export interface KeyInfo {
  method: 'NONE' | 'AES-128' | 'SAMPLE-AES' | string;
  uri?: string; // absolute
  iv?: string; // hex with 0x prefix, as in manifest
}

export interface MediaPlaylist {
  kind: 'media';
  segments: string[]; // absolute segment URLs
  initSegment?: string; // absolute, from #EXT-X-MAP
  durationSec: number; // sum of #EXTINF
  endlist: boolean; // #EXT-X-ENDLIST present (VOD)
  key?: KeyInfo;
  encryption: Encryption;
  mediaSequence: number; // #EXT-X-MEDIA-SEQUENCE (default 0); used for default IV
}

/** An #EXT-X-MEDIA:TYPE=AUDIO rendition (demuxed audio group member). */
interface AudioRendition {
  groupId: string;
  uri: string; // absolute media-playlist URL
  isDefault: boolean;
}

/** Pick the audio media-playlist URL for a STREAM-INF's AUDIO group. */
function audioForGroup(audio: AudioRendition[], groupId?: string): string | undefined {
  if (!groupId) return undefined;
  const inGroup = audio.filter((a) => a.groupId === groupId && a.uri);
  if (!inGroup.length) return undefined;
  return (inGroup.find((a) => a.isDefault) ?? inGroup[0]).uri;
}

export function parseMaster(text: string, baseUrl: string): MasterPlaylist {
  const lines = text.split(/\r?\n/);

  // Pass 1: collect demuxed audio renditions.
  const audio: AudioRendition[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('#EXT-X-MEDIA')) continue;
    const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
    if (attrs['TYPE'] !== 'AUDIO' || !attrs['URI']) continue;
    audio.push({
      groupId: attrs['GROUP-ID'] ?? '',
      uri: resolveUrl(baseUrl, attrs['URI']),
      isDefault: attrs['DEFAULT'] === 'YES',
    });
  }

  // Pass 2: video variants, each mapped to its audio group (if demuxed).
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
    // Next non-comment line is the variant URI.
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (next && !next.startsWith('#')) {
        uri = next;
        break;
      }
    }
    if (!uri) continue;
    const resolution = attrs['RESOLUTION'];
    const height = resolution ? Number(resolution.split('x')[1]) : undefined;
    variants.push({
      url: resolveUrl(baseUrl, uri),
      bandwidth: Number(attrs['BANDWIDTH'] || attrs['AVERAGE-BANDWIDTH'] || 0),
      resolution,
      codecs: attrs['CODECS'],
      height: Number.isFinite(height) ? height : undefined,
      audioUrl: audioForGroup(audio, attrs['AUDIO']),
    });
  }
  // Highest bandwidth first.
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { kind: 'master', variants };
}

function classifyEncryption(method?: string): Encryption {
  if (!method || method === 'NONE') return 'none';
  if (method === 'AES-128') return 'aes-128';
  return 'unsupported-drm'; // SAMPLE-AES, etc.
}

export function parseMedia(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: string[] = [];
  let durationSec = 0;
  let endlist = false;
  let initSegment: string | undefined;
  let key: KeyInfo | undefined;
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-ENDLIST')) {
      endlist = true;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      const v = parseInt(line.slice(line.indexOf(':') + 1), 10);
      if (Number.isFinite(v)) mediaSequence = v;
    } else if (line.startsWith('#EXTINF')) {
      const dur = parseFloat(line.slice(line.indexOf(':') + 1));
      if (Number.isFinite(dur)) durationSec += dur;
    } else if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (attrs['URI']) initSegment = resolveUrl(baseUrl, attrs['URI']);
    } else if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      key = {
        method: attrs['METHOD'] || 'NONE',
        uri: attrs['URI'] ? resolveUrl(baseUrl, attrs['URI']) : undefined,
        iv: attrs['IV'],
      };
    } else if (!line.startsWith('#')) {
      segments.push(resolveUrl(baseUrl, line));
    }
  }

  return {
    kind: 'media',
    segments,
    initSegment,
    durationSec,
    endlist,
    key,
    encryption: classifyEncryption(key?.method),
    mediaSequence,
  };
}
