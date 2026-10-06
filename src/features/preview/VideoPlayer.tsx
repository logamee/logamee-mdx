/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：ref 经依赖束传递，效果依赖保持提取前原样 */
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

  useMpegtsPlayback({ mediaRef, onErrorRef, onLoadedRef, playbackMode, sourceUrl });

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

// mpegts/flv 播放接线：懒加载库、事件桥接与完整卸载。
function useMpegtsPlayback(deps: {
  mediaRef: React.RefObject<HTMLVideoElement | null>;
  onLoadedRef: React.RefObject<() => void>;
  onErrorRef: React.RefObject<() => void>;
  playbackMode: 'flv' | 'mpegts' | 'native';
  sourceUrl: string;
}): void {
  const { mediaRef, playbackMode, sourceUrl } = deps;
  useEffect(() => {
    if ((playbackMode !== 'flv' && playbackMode !== 'mpegts') || !mediaRef.current || !sourceUrl) return undefined;
    let disposed = false;
    let destroyPlayer: (() => void) | undefined;

    void import('mpegts.js')
      .then(({ default: mpegts }) => {
        if (disposed) return;
        if (!mpegts.isSupported()) {
          deps.onErrorRef.current();
          return;
        }

        destroyPlayer = wireMpegtsPlayer({
          mpegts,
          media: mediaRef.current!,
          onLoaded: () => { if (!disposed) deps.onLoadedRef.current(); },
          onError: () => { if (!disposed) deps.onErrorRef.current(); },
          playbackMode,
          sourceUrl,
        });
      })
      .catch(() => {
        if (!disposed) deps.onErrorRef.current();
      });

    return () => {
      disposed = true;
      destroyPlayer?.();
    };
  }, [playbackMode, sourceUrl]);
}

// 创建播放器、桥接事件并返回完整卸载函数。
function wireMpegtsPlayer(args: {
  media: HTMLVideoElement;
  mpegts: typeof import('mpegts.js').default;
  onLoaded: () => void;
  onError: () => void;
  playbackMode: 'flv' | 'mpegts';
  sourceUrl: string;
}): () => void {
  const { mpegts, media, playbackMode, sourceUrl } = args;
  const player = mpegts.createPlayer({ type: playbackMode, url: sourceUrl, cors: true });
  const handleError = args.onError;
  const handleMediaInfo = args.onLoaded;
  player.on(mpegts.Events.ERROR, handleError);
  player.on(mpegts.Events.MEDIA_INFO, handleMediaInfo);
  player.attachMediaElement(media);
  player.load();
  void Promise.resolve(player.play()).catch(() => undefined);
  return () => {
    player.off(mpegts.Events.ERROR, handleError);
    player.off(mpegts.Events.MEDIA_INFO, handleMediaInfo);
    player.unload();
    player.detachMediaElement();
    player.destroy();
  };
}
