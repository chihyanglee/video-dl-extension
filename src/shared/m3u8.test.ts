import { describe, it, expect } from 'vitest';
import { isMaster, parseMaster, parseMedia } from './m3u8';

describe('isMaster', () => {
  it('detects a master playlist by #EXT-X-STREAM-INF', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n360.m3u8\n';
    expect(isMaster(master)).toBe(true);
  });

  it('returns false for a media playlist', () => {
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n';
    expect(isMaster(media)).toBe(false);
  });
});

describe('parseMaster', () => {
  it('sorts muxed variants highest-bandwidth first and resolves relative URIs', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      '360.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      '720.m3u8',
    ].join('\n');
    const { variants } = parseMaster(text, 'https://h/path/master.m3u8');
    expect(variants).toHaveLength(2);
    expect(variants[0].height).toBe(720);
    expect(variants[0].url).toBe('https://h/path/720.m3u8');
    expect(variants[0].audioUrl).toBeUndefined();
    expect(variants[1].height).toBe(360);
  });

  it('resolves each variant audioUrl to the DEFAULT=YES audio rendition', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,URI="/v/aud.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=950000,RESOLUTION=480x848,AUDIO="aud"',
      '/v/480.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=720x1280,AUDIO="aud"',
      '/v/720.m3u8',
    ].join('\n');
    const { variants } = parseMaster(text, 'https://video.twimg.com/x/master.m3u8');
    expect(variants).toHaveLength(2);
    expect(variants[0].height).toBe(1280);
    expect(variants[0].audioUrl).toBe('https://video.twimg.com/v/aud.m3u8');
    expect(variants[1].audioUrl).toBe('https://video.twimg.com/v/aud.m3u8');
  });
});

describe('parseMedia', () => {
  it('parses an unencrypted VOD playlist', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXTINF:4.0,',
      'seg0.ts',
      '#EXTINF:4.0,',
      'seg1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const media = parseMedia(text, 'https://h/path/media.m3u8');
    expect(media.endlist).toBe(true);
    expect(media.segments).toHaveLength(2);
    expect(media.durationSec).toBe(8);
    expect(media.encryption).toBe('none');
    expect(media.segments[0].url).toBe('https://h/path/seg0.ts');
    expect(media.segments[1].url).toBe('https://h/path/seg1.ts');
    expect(media.segments[0].byteRange).toBeUndefined();
  });

  it('parses CMAF single-file byte-range segments (#EXT-X-BYTERANGE)', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-MAP:URI="v.m4s",BYTERANGE="895@0"',
      '#EXTINF:6.0,',
      '#EXT-X-BYTERANGE:1285448@975',
      'v.m4s',
      '#EXTINF:6.0,',
      '#EXT-X-BYTERANGE:1261697', // offset omitted → continues from previous end
      'v.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const media = parseMedia(text, 'https://h/path/media.m3u8');
    expect(media.initSegment?.url).toBe('https://h/path/v.m4s');
    expect(media.initSegment?.byteRange).toEqual({ offset: 0, length: 895 });
    expect(media.segments).toHaveLength(2);
    expect(media.segments[0].url).toBe('https://h/path/v.m4s');
    expect(media.segments[0].byteRange).toEqual({ offset: 975, length: 1285448 });
    // Second segment's offset is implied: 975 + 1285448 = 1286423.
    expect(media.segments[1].byteRange).toEqual({ offset: 1286423, length: 1261697 });
  });

  it('parses AES-128 encryption with an explicit IV and absolute key URI', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00112233445566778899aabbccddeeff',
      '#EXTINF:4.0,',
      'seg0.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const media = parseMedia(text, 'https://h/path/media.m3u8');
    expect(media.encryption).toBe('aes-128');
    expect(media.key?.uri).toBe('https://h/path/key.bin');
    expect(media.key?.iv).toBe('0x00112233445566778899aabbccddeeff');
  });

  it('flags SAMPLE-AES as unsupported DRM', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"',
      '#EXTINF:4.0,',
      'seg0.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const media = parseMedia(text, 'https://h/path/media.m3u8');
    expect(media.encryption).toBe('unsupported-drm');
  });

  it('resolves the fMP4 init segment from #EXT-X-MAP', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.0,',
      'seg0.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const media = parseMedia(text, 'https://h/path/media.m3u8');
    expect(media.initSegment?.url).toBe('https://h/path/init.mp4');
  });

  it('reports endlist=false for a live playlist', () => {
    const text = ['#EXTM3U', '#EXTINF:4.0,', 'seg0.ts'].join('\n');
    const media = parseMedia(text, 'https://h/path/media.m3u8');
    expect(media.endlist).toBe(false);
  });
});
