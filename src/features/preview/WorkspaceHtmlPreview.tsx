import { useState } from 'react';
import { useWorkspaceHtmlPreviewSource } from './workspaceHtmlPreviewSource';
import { displayName } from '../../lib/documentNames';
import { HTML_PREVIEW_SANDBOX } from '../../lib/htmlPreviewPolicy';
import { useI18n } from '../../lib/i18n';

interface WorkspaceHtmlPreviewProps {
  content: string;
  enabled?: boolean;
  path: string;
}

interface HtmlPreviewFrameProps {
  name: string;
  onLoad?: () => void;
  url: string;
}

interface HtmlPreviewSurfaceProps extends HtmlPreviewFrameProps {
  loaded: boolean;
  onLoad: () => void;
}

function HtmlPreviewStatus({ busy, message, overlay = false }: { busy: boolean; message: string; overlay?: boolean }) {
  return (
    <output
      className={`workspace-html-status${overlay ? ' is-overlay' : ''}`}
      aria-busy={busy}
      aria-live="polite"
    >
      {busy && <span className="workspace-html-spinner" aria-hidden="true" />}
      <span>{message}</span>
    </output>
  );
}

export function HtmlPreviewFrame({ name, onLoad, url }: HtmlPreviewFrameProps) {
  const { t } = useI18n();
  return (
    <iframe
      className="workspace-html-frame"
      title={t('htmlPreview', { name })}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      src={url}
    />
  );
}

export function HtmlPreviewSurface({ loaded, name, onLoad, url }: HtmlPreviewSurfaceProps) {
  const { t } = useI18n();
  return (
    <>
      <HtmlPreviewFrame name={name} onLoad={onLoad} url={url} />
      {!loaded && (
        <HtmlPreviewStatus busy message={t('loadingHtml')} overlay />
      )}
    </>
  );
}

export function WorkspaceHtmlPreview({ content, enabled = true, path }: WorkspaceHtmlPreviewProps) {
  const { t } = useI18n();
  const name = displayName(path);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const { failed, previewUrl } = useWorkspaceHtmlPreviewSource({ content, enabled, path });

  return (
    <div className="workspace-html-preview">
      {previewUrl ? (
        <HtmlPreviewSurface
          loaded={loadedUrl === previewUrl}
          name={name}
          onLoad={() => setLoadedUrl(previewUrl)}
          url={previewUrl}
        />
      ) : (
        <HtmlPreviewStatus
          busy={!failed}
          message={failed ? t('htmlPreviewUnavailable') : t('startingHtmlPreview')}
        />
      )}
    </div>
  );
}
