import { describe, it, expect } from 'vitest';
import { parseIsoDuration, parseMpd, buildSegmentUrls, type DashRep } from './mpd';

describe('parseIsoDuration', () => {
  it('parses hours/minutes/fractional seconds', () => {
    expect(parseIsoDuration('PT1H2M3.5S')).toBe(3723.5);
  });
  it('parses seconds only', () => {
    expect(parseIsoDuration('PT30S')).toBe(30);
  });
  it('returns 0 for undefined', () => {
    expect(parseIsoDuration(undefined)).toBe(0);
  });
});

describe('parseMpd', () => {
  const staticMpd = [
    '<?xml version="1.0"?>',
    '<MPD type="static" mediaPresentationDuration="PT10S">',
    '  <Period>',
    '    <AdaptationSet mimeType="video/mp4">',
    '      <Representation id="v0" bandwidth="2000000" width="1280" height="720">',
    '        <SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number$.m4s" duration="4" timescale="1" startNumber="1"/>',
    '      </Representation>',
    '    </AdaptationSet>',
    '    <AdaptationSet mimeType="audio/mp4">',
    '      <Representation id="a0" bandwidth="128000">',
    '        <SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number$.m4s" duration="4" timescale="1" startNumber="1"/>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
  ].join('\n');

  it('parses a static SegmentTemplate MPD as supported', () => {
    const r = parseMpd(staticMpd, 'https://h/base/manifest.mpd');
    expect(r.supported).toBe(true);
    expect(r.type).toBe('static');
    expect(r.video).toHaveLength(1);
    expect(r.audio).toHaveLength(1);
  });

  it('flags a dynamic (live) MPD as unsupported', () => {
    const dynamic = staticMpd.replace('type="static"', 'type="dynamic"');
    const r = parseMpd(dynamic, 'https://h/base/manifest.mpd');
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('Live stream');
  });

  it('flags a ContentProtection MPD as DRM-protected', () => {
    const drm = staticMpd.replace(
      '<Representation id="v0" bandwidth="2000000" width="1280" height="720">',
      '<Representation id="v0" bandwidth="2000000" width="1280" height="720"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>',
    );
    const r = parseMpd(drm, 'https://h/base/manifest.mpd');
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('DRM-protected');
  });
});

describe('buildSegmentUrls', () => {
  it('builds init + numbered media URLs from @duration', () => {
    const rep: DashRep = {
      id: 'v0',
      bandwidth: 2000000,
      initTemplate: 'https://h/$RepresentationID$/init.mp4',
      mediaTemplate: 'https://h/$RepresentationID$/seg-$Number%03d$.m4s',
      startNumber: 1,
      segDurationSec: 4,
      timescale: 1,
    };
    const { initUrl, mediaUrls } = buildSegmentUrls(rep, 10);
    expect(initUrl).toBe('https://h/v0/init.mp4');
    expect(mediaUrls).toHaveLength(3);
    expect(mediaUrls[0]).toBe('https://h/v0/seg-001.m4s');
  });

  it('expands a SegmentTimeline with repeats', () => {
    const rep: DashRep = {
      id: 'v0',
      bandwidth: 2000000,
      mediaTemplate: 'https://h/$RepresentationID$/seg-$Number$.m4s',
      startNumber: 1,
      timeline: [{ t: 0, d: 4, r: 2 }],
      timescale: 1,
    };
    const { mediaUrls } = buildSegmentUrls(rep, 12);
    expect(mediaUrls).toHaveLength(3);
  });
});
