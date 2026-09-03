import { useEffect, useRef } from 'react';

export function getMediaPlaybackMode(path: string): 'flv' | 'mpegts' | 'native' {
  const extension = path.toLowerCase().split(/[?#]/u, 1)[0]?.split('.').pop();
  if (extension === 'flv') return 'flv';
  if (extension === 'm2ts') return 'mpegts';
  return 'native';
}

interface VideoPlayerProps {
  ariaLabel?: string;
  className?: string;
  onError: () => void;
  onLoaded: () => void;
  sourceUrl: string;
  path: string;
}

export function VideoPlayer({ ariaLabel, className, onError, onLoaded, path, sourceUrl }: VideoPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  const onErrorRef = useRef(onError);
  const onLoadedRef = useRef(onLoaded);
  onErrorRef.current = onError;
  onLoadedRef.current = onLoaded;
  const playbackMode = getMediaPlaybackMode(path);

  useEffect(() => {
    if (playbackMode !== 'native' || !sourceUrl) return;
    mediaRef.current?.load();
  }, [playbackMode, sourceUrl]);

  useEffect(() => {
    if ((playbackMode !== 'flv' && playbackMode !== 'mpegts') || !mediaRef.current || !sourceUrl) return undefined;
    let disposed = false;
    let destroyPlayer: (() => void) | undefined;

    void import('mpegts.js')
      .then(({ default: mpegts }) => {
        if (disposed) return;
        if (!mpegts.isSupported()) {
          onErrorRef.current();
          return;
        }

        const player = mpegts.createPlayer({ type: playbackMode, url: sourceUrl, cors: true });
        const handleError = () => {
          if (!disposed) onErrorRef.current();
        };
        const handleMediaInfo = () => {
          if (!disposed) onLoadedRef.current();
        };
        player.on(mpegts.Events.ERROR, handleError);
        player.on(mpegts.Events.MEDIA_INFO, handleMediaInfo);
        player.attachMediaElement(mediaRef.current!);
        player.load();
        void Promise.resolve(player.play()).catch(() => undefined);
        destroyPlayer = () => {
          player.off(mpegts.Events.ERROR, handleError);
          player.off(mpegts.Events.MEDIA_INFO, handleMediaInfo);
          player.unload();
          player.detachMediaElement();
          player.destroy();
        };
      })
      .catch(() => {
        if (!disposed) onErrorRef.current();
      });

    return () => {
      disposed = true;
      destroyPlayer?.();
    };
  }, [playbackMode, sourceUrl]);

  return (
    /* oxlint-disable-next-line jsx-a11y/media-has-caption -- Local workspace videos do not guarantee a caption track. */
    <video
      ref={mediaRef}
      className={className}
      controls
      playsInline
      preload="metadata"
      src={playbackMode === 'native' ? sourceUrl : undefined}
      aria-label={ariaLabel}
      onLoadedMetadata={onLoaded}
      onError={onError}
    />
  );
}
