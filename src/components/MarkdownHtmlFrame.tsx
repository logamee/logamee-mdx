import { useEffect, useState } from 'react';
import { emitAppFeedbackError } from '../lib/appFeedback';
import { displayName } from '../lib/documentNames';
import { MARKDOWN_HTML_EMBED_SANDBOX } from '../lib/htmlPreviewPolicy';
import { useI18n } from '../lib/i18n';
import { prepareMarkdownHtmlEmbed, releaseMarkdownHtmlEmbed } from '../lib/tauriCommands';

interface MarkdownHtmlFrameProps {
  currentFilePath: string | null;
  enabled: boolean;
  htmlSrc: string;
  title?: string;
  workspaceRoot?: string | null;
}

type HtmlEmbedRequestState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'failed' }
  | { key: string; status: 'ready'; url: string };

export function MarkdownHtmlFrame({ currentFilePath, enabled, htmlSrc, title, workspaceRoot = null }: MarkdownHtmlFrameProps) {
  const { t } = useI18n();
  const [requestState, setRequestState] = useState<HtmlEmbedRequestState | null>(null);
  const requestKey = currentFilePath && enabled
    ? JSON.stringify([currentFilePath, htmlSrc, workspaceRoot])
    : null;
  useEffect(() => {
    let active = true;
    let ownerId: number | null = null;
    if (!currentFilePath || !requestKey) return () => {
      active = false;
    };
    setRequestState({ key: requestKey, status: 'loading' });

    void prepareMarkdownHtmlEmbed(currentFilePath, htmlSrc, workspaceRoot)
      .then((lease) => {
        if (!active) {
          void releaseMarkdownHtmlEmbed(lease.ownerId).catch(() => undefined);
          return;
        }
        ownerId = lease.ownerId;
        setRequestState({ key: requestKey, status: 'ready', url: lease.url });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRequestState({ key: requestKey, status: 'failed' });
        emitAppFeedbackError(error);
      });

    return () => {
      active = false;
      if (ownerId !== null) {
        void releaseMarkdownHtmlEmbed(ownerId).catch(() => undefined);
      }
    };
  }, [currentFilePath, htmlSrc, requestKey, workspaceRoot]);

  const currentState = requestState?.key === requestKey ? requestState : null;
  if (currentState?.status !== 'ready') {
    const busy = requestKey !== null && currentState?.status !== 'failed';
    return (
      <output className="mmd-html-embed-status" aria-busy={busy} aria-live="polite">
        {busy ? t('startingHtmlPreview') : t('htmlPreviewUnavailable')}
      </output>
    );
  }

  const frameTitle = title || t('htmlPreview', { name: displayName(htmlSrc) });
  return (
    <>
      {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role -- A section is invalid inside a Markdown paragraph; this scroll region needs keyboard focus. */}
      <span
        className="mmd-html-embed-viewport"
        role="region"
        tabIndex={0}
        aria-label={frameTitle}
      >
        <iframe
          className="mmd-html-embed-frame"
          loading="eager"
          referrerPolicy="no-referrer"
          sandbox={MARKDOWN_HTML_EMBED_SANDBOX}
          src={currentState.url}
          title={frameTitle}
        />
      </span>
      {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role */}
    </>
  );
}
