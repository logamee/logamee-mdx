import { useEffect, useRef, useState } from 'react';
import { displayName } from '../lib/documentNames';
import { emitAppFeedbackError } from '../lib/appFeedback';
import { HTML_PREVIEW_SANDBOX } from '../lib/htmlPreviewPolicy';
import { prepareHtmlPreview } from '../lib/tauriCommands';
import { useI18n } from '../lib/i18n';

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
  const { locale, t } = useI18n();
  const name = displayName(path);
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let active = true;
    setFailed(false);
    if (!enabled) {
      setPreview(null);
      setLoadedUrl(null);
      return () => {
        active = false;
      };
    }
    const timer = window.setTimeout(() => {
      void prepareHtmlPreview(path, content)
        .then((url) => {
          if (!active || requestId !== requestIdRef.current) return;
          const separator = url.includes('?') ? '&' : '?';
          setPreview({ path, url: `${url}${separator}mmdPreview=${requestId}` });
        })
        .catch((error: unknown) => {
          if (!active || requestId !== requestIdRef.current) return;
          setPreview(null);
          setFailed(true);
          emitAppFeedbackError(error);
        });
    }, 200);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [content, enabled, locale, path]);

  const previewUrl = preview?.path === path ? preview.url : null;

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
