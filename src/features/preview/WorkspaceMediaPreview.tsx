import type { Ref } from 'react';
import type { PanePopoutButtonState } from '../../lib/paneLayout';
import { displayName } from '../../lib/documentNames';
import { PaneHeader } from '../../components/PaneHeader';
import { useI18n } from '../../lib/i18n';
import { VideoPlayer } from './VideoPlayer';
import { useMediaPreviewLease } from './mediaPreviewLease';

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

export function WorkspaceMediaPreview({ enabled = true, kind, onPopout, paneRef, path, popout = false, popoutButton, previewRevision }: WorkspaceMediaPreviewProps) {
  const { t } = useI18n();
  const lease = useMediaPreviewLease({ enabled, path, previewRevision });

  return (
    <section className={popout ? 'workspace-media-preview popout-pane' : 'workspace-media-preview'} ref={paneRef}>
      <PaneHeader title={t('mediaPreview')} subtitle={displayName(path)} popoutButton={popoutButton} onPopout={onPopout} />
      <MediaPreviewViewport
        enabled={enabled}
        failed={lease.failed}
        kind={kind}
        loaded={lease.loaded}
        markFailed={lease.markFailed}
        markLoaded={lease.markLoaded}
        path={path}
        sourceUrl={lease.sourceUrl}
        statusLabel={t('loadingMedia')}
        errorLabel={t('mediaLoadFailed')}
      />
    </section>
  );
}

// 媒体视口：加载/失败状态与音频/视频播放器按状态切换。
function MediaPreviewViewport(props: {
  enabled: boolean;
  failed: boolean;
  kind: 'audio' | 'video';
  loaded: boolean;
  markFailed: () => void;
  markLoaded: () => void;
  path: string;
  sourceUrl: string | null;
  statusLabel: string;
  errorLabel: string;
}) {
  const { enabled, failed, kind, loaded, markFailed, markLoaded, path, sourceUrl } = props;
  const showPlayer = enabled && !failed && sourceUrl !== null;
  return (
    <div className="workspace-media-viewport" aria-busy={!loaded && !failed}>
      <MediaPreviewStatus
        errorLabel={props.errorLabel}
        failed={failed}
        loaded={loaded}
        statusLabel={props.statusLabel}
      />
      {showPlayer && kind === 'audio' && <MediaAudioPlayer markFailed={markFailed} markLoaded={markLoaded} sourceUrl={sourceUrl} />}
      {showPlayer && kind === 'video' && <MediaVideoPlayer loaded={loaded} markFailed={markFailed} markLoaded={markLoaded} path={path} sourceUrl={sourceUrl} />}
    </div>
  );
}

// 加载/失败状态输出。
function MediaPreviewStatus(props: { errorLabel: string; failed: boolean; loaded: boolean; statusLabel: string }) {
  if (props.failed) return <span className="workspace-media-error">{props.errorLabel}</span>;
  if (props.loaded) return null;
  return <output className="workspace-media-status">{props.statusLabel}</output>;
}

function MediaAudioPlayer(props: { markFailed: () => void; markLoaded: () => void; sourceUrl: string }) {
  return (
    /* oxlint-disable-next-line jsx-a11y/media-has-caption -- Arbitrary local audio files do not have a guaranteed caption track. */
    <audio className="workspace-audio" controls preload="metadata" src={props.sourceUrl} onLoadedMetadata={props.markLoaded} onError={props.markFailed} />
  );
}

function MediaVideoPlayer(props: { loaded: boolean; markFailed: () => void; markLoaded: () => void; path: string; sourceUrl: string }) {
  return (
    <VideoPlayer
      className={props.loaded ? 'workspace-video is-loaded' : 'workspace-video'}
      onError={props.markFailed}
      onLoaded={props.markLoaded}
      path={props.path}
      sourceUrl={props.sourceUrl}
    />
  );
}
