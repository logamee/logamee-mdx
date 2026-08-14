import { useEffect, useRef, useState, type Ref } from 'react';
import type { PanePopoutButtonState } from '../lib/paneLayout';
import { emitAppFeedbackError } from '../lib/appFeedback';
import { displayName } from '../lib/documentNames';
import { resolveWorkspaceMedia } from '../lib/tauriCommands';
import { getWorkspacePreviewUrl } from '../lib/workspacePreviewSource';
import { PaneHeader } from './PaneHeader';
import { useI18n } from '../lib/i18n';

interface WorkspaceMediaPreviewProps {
  enabled?: boolean;
  kind: 'audio' | 'video';
  mimeType: string;
  onPopout?: () => void;
  paneRef?: Ref<HTMLElement>;
  path: string;
  popout?: boolean;
  popoutButton?: PanePopoutButtonState;
  previewRevision: number;
}

export function getMediaPlaybackMode(path: string): 'flv' | 'native' {
  return path.toLowerCase().endsWith('.flv') ? 'flv' : 'native';
}

export function WorkspaceMediaPreview({ enabled = true, kind, mimeType, onPopout, paneRef, path, popout = false, popoutButton, previewRevision }: WorkspaceMediaPreviewProps) {
  const { locale, t } = useI18n();
  const audioRef = useRef<HTMLAudioElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const playbackMode = getMediaPlaybackMode(path);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    setSourceUrl(null);
    if (!enabled) return undefined;
    let cancelled = false;
    resolveWorkspaceMedia(path)
      .then((resolvedPath) => {
        if (!cancelled) setSourceUrl(getWorkspacePreviewUrl(resolvedPath, previewRevision));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        emitAppFeedbackError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, locale, mimeType, path, previewRevision]);

  useEffect(() => {
    if (!enabled || playbackMode !== 'native' || !sourceUrl) return;
    const mediaElement = kind === 'audio' ? audioRef.current : mediaRef.current;
    mediaElement?.load();
  }, [enabled, kind, playbackMode, sourceUrl]);

  useEffect(() => {
    if (!enabled || kind !== 'video' || playbackMode !== 'flv' || !mediaRef.current || !sourceUrl) return undefined;
    let disposed = false;
    let destroyPlayer: (() => void) | undefined;

    void import('mpegts.js')
      .then(({ default: mpegts }) => {
        if (disposed) return;
        if (!mpegts.isSupported()) {
          setFailed(true);
          emitAppFeedbackError('Media playback is not supported by this WebView');
          return;
        }

        const player = mpegts.createPlayer({ type: 'flv', url: sourceUrl, cors: true });
        const handleError = () => {
          if (disposed) return;
          setFailed(true);
          emitAppFeedbackError('Failed to play media');
        };
        const handleMediaInfo = () => {
          if (!disposed) setLoaded(true);
        };
        player.on(mpegts.Events.ERROR, handleError);
        player.on(mpegts.Events.MEDIA_INFO, handleMediaInfo);
        player.attachMediaElement(mediaRef.current!);
        player.load();
        destroyPlayer = () => {
          player.off(mpegts.Events.ERROR, handleError);
          player.off(mpegts.Events.MEDIA_INFO, handleMediaInfo);
          player.unload();
          player.detachMediaElement();
          player.destroy();
        };
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setFailed(true);
        emitAppFeedbackError(error);
      });

    return () => {
      disposed = true;
      destroyPlayer?.();
    };
  }, [enabled, kind, locale, playbackMode, sourceUrl]);

  const handlePlaybackError = () => {
    setFailed(true);
    emitAppFeedbackError('Failed to play media');
  };

  return (
    <section className={popout ? 'workspace-media-preview popout-pane' : 'workspace-media-preview'} ref={paneRef}>
      <PaneHeader title={t('mediaPreview')} subtitle={displayName(path)} popoutButton={popoutButton} onPopout={onPopout} />
      <div className="workspace-media-viewport" aria-busy={!loaded && !failed}>
        {!failed && !loaded && <output className="workspace-media-status">{t('loadingMedia')}</output>}
        {failed && <span className="workspace-media-error">{t('mediaLoadFailed')}</span>}
        {enabled && !failed && kind === 'audio' && sourceUrl && (
          /* oxlint-disable-next-line jsx-a11y/media-has-caption -- Arbitrary local audio files do not have a guaranteed caption track. */
          <audio ref={audioRef} className="workspace-audio" controls preload="metadata" src={sourceUrl} onLoadedMetadata={() => setLoaded(true)} onError={handlePlaybackError} />
        )}
        {enabled && !failed && kind === 'video' && sourceUrl && (
          /* oxlint-disable-next-line jsx-a11y/media-has-caption -- Arbitrary local video files do not have a guaranteed caption track. */
          <video
            ref={mediaRef}
            className={loaded ? 'workspace-video is-loaded' : 'workspace-video'}
            controls
            playsInline
            preload="metadata"
            src={playbackMode === 'native' ? sourceUrl : undefined}
            onLoadedMetadata={() => setLoaded(true)}
            onError={playbackMode === 'native' ? handlePlaybackError : undefined}
          />
        )}
      </div>
    </section>
  );
}
