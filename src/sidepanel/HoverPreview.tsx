import Hls from 'hls.js';
import { useEffect, useRef } from 'react';
import { installRefererRule, removeRefererRule } from './referer';

interface Props {
  variantUrl: string;
  native?: boolean; // direct file → plain <video src>, no hls.js
  referer?: string; // for hotlink-protected files: rewrite Referer on the element's requests
}

/**
 * On-mount mini-player. Mounted only while a row is hovered (parent controls
 * lifetime), so at most one instance is live at a time. HLS streams go through
 * hls.js; direct files play natively. Tears down on unmount.
 */
export function HoverPreview({ variantUrl, native, referer }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: Hls | null = null;
    let ruleId: number | undefined;

    if (native) {
      // Hotlink-protected files 403 without a Referer; the element can't set the
      // forbidden header, so rewrite it with a DNR rule for this host that lives
      // as long as the player. Cross-origin playback needs no CORS (no crossorigin
      // attr), so streaming directly is fine — no full download like the thumbnail.
      const start = () => {
        video.src = variantUrl;
        video.play().catch(() => void 0);
      };
      if (referer) {
        installRefererRule(new URL(variantUrl).hostname, referer)
          .then((id) => {
            ruleId = id;
            start();
          })
          .catch(start); // rule failed → try direct anyway
      } else {
        start();
      }
    } else if (Hls.isSupported()) {
      hls = new Hls({
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
        maxBufferLength: 4,
      });
      hls.loadSource(variantUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => void 0));
    }
    return () => {
      hls?.destroy();
      if (ruleId != null) void removeRefererRule(ruleId);
    };
  }, [variantUrl, native, referer]);

  return (
    <video
      ref={videoRef}
      muted
      playsInline
      loop
      className="hover-preview"
      style={{ width: '100%', borderRadius: 6, background: '#000' }}
    />
  );
}
