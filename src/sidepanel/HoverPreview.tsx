import Hls from 'hls.js';
import { useEffect, useRef } from 'react';

interface Props {
  variantUrl: string;
}

/**
 * On-mount HLS mini-player. Mounted only while a row is hovered (parent controls
 * lifetime), so at most one instance is live at a time. Destroys hls.js on unmount.
 */
export function HoverPreview({ variantUrl }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: Hls | null = null;

    if (Hls.isSupported()) {
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
    };
  }, [variantUrl]);

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
