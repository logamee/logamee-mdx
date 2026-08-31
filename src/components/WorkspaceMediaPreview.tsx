import { useEffect, useRef, useState, type Ref } from 'react';
import type { PanePopoutButtonState } from '../lib/paneLayout';
import { emitAppFeedbackError } from '../lib/appFeedback';
import { displayName } from '../lib/documentNames';
import { resolveWorkspaceMedia } from '../lib/tauriCommands';
import { getWorkspacePreviewUrl } from '../lib/workspacePreviewSource';
import { PaneHeader } from './PaneHeader';
import { useI18n } from '../lib/i18n';
import { VideoPlayer } from './VideoPlayer';

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

export { getMediaPlaybackMode } from './VideoPlayer';

export function WorkspaceMediaPreview({ enabled = true, kind, mimeType, onPopout, paneRef, path, popout = false, popoutButton, previewRevision }: WorkspaceMediaPreviewProps) {
  const { locale, t } = useI18n();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

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
          <VideoPlayer
            className={loaded ? 'workspace-video is-loaded' : 'workspace-video'}
            onError={handlePlaybackError}
            onLoaded={() => setLoaded(true)}
            path={path}
            sourceUrl={sourceUrl}
          />
        )}
      </div>
    </section>
  );
}
