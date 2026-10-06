import { useEffect, useState, type Ref } from 'react';
import type { PanePopoutButtonState } from '../../lib/paneLayout';
import { emitAppFeedbackError } from '../../lib/appFeedback';
import { displayName } from '../../lib/documentNames';
import { readWorkspaceImage } from '../../lib/tauriCommands';
import { PaneHeader } from '../../components/PaneHeader';
import { useI18n } from '../../lib/i18n';

interface WorkspaceImagePreviewProps {
  enabled?: boolean;
  onPopout?: () => void;
  paneRef?: Ref<HTMLElement>;
  path: string;
  popout?: boolean;
  popoutButton?: PanePopoutButtonState;
  previewRevision: number;
}

export function WorkspaceImagePreview({ enabled = true, onPopout, paneRef, path, popout = false, popoutButton, previewRevision }: WorkspaceImagePreviewProps) {
  const { locale, t } = useI18n();
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResolvedSrc(null);
    setFailed(false);
    setLoaded(false);
    if (!enabled) return undefined;
    readWorkspaceImage(path)
      .then((dataUrl) => {
        if (!cancelled) setResolvedSrc(dataUrl);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        emitAppFeedbackError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, locale, path, previewRevision]);

  return (
    <section className={popout ? 'workspace-image-preview popout-pane' : 'workspace-image-preview'} ref={paneRef}>
      <PaneHeader title={t('imagePreview')} subtitle={displayName(path)} popoutButton={popoutButton} onPopout={onPopout} />
      <div className="workspace-image-viewport" aria-busy={!loaded && !failed}>
        <WorkspaceImageStatus failed={failed} loaded={loaded} loadingLabel={t('loadingImage')} errorLabel={t('imageLoadFailed')} />
        {resolvedSrc && !failed && (
          <img
            className={loaded ? 'workspace-image is-loaded' : 'workspace-image'}
            src={resolvedSrc}
            alt={displayName(path)}
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => {
              setFailed(true);
              emitAppFeedbackError('Image preview could not be displayed');
            }}
          />
        )}
      </div>
    </section>
  );
}

// 加载/失败状态输出。
function WorkspaceImageStatus(props: { errorLabel: string; failed: boolean; loaded: boolean; loadingLabel: string }) {
  if (props.failed) return <span className="workspace-image-error">{props.errorLabel}</span>;
  if (!props.loaded) return <output className="workspace-image-status">{props.loadingLabel}</output>;
  return null;
}
