import { displayName } from '../../lib/documentNames';
import { MARKDOWN_HTML_EMBED_SANDBOX } from '../../lib/htmlPreviewPolicy';
import { useI18n } from '../../lib/i18n';
import { useMarkdownHtmlEmbedLease } from './markdownHtmlEmbedLease';

interface MarkdownHtmlFrameProps {
  currentFilePath: string | null;
  enabled: boolean;
  htmlSrc: string;
  title?: string;
  workspaceRoot?: string | null;
}

export function MarkdownHtmlFrame({ currentFilePath, enabled, htmlSrc, title, workspaceRoot = null }: MarkdownHtmlFrameProps) {
  const { t } = useI18n();
  const requestKey = currentFilePath && enabled
    ? JSON.stringify([currentFilePath, htmlSrc, workspaceRoot])
    : null;
  const requestState = useMarkdownHtmlEmbedLease({ currentFilePath, htmlSrc, requestKey, workspaceRoot });
  const currentState = requestState?.key === requestKey ? requestState : null;
  if (currentState?.status !== 'ready') {
    return (
      <HtmlEmbedStatusOutput
        currentState={currentState}
        requestKey={requestKey}
        startingLabel={t('startingHtmlPreview')}
        unavailableLabel={t('htmlPreviewUnavailable')}
      />
    );
  }

  const frameTitle = title || t('htmlPreview', { name: displayName(htmlSrc) });
  return <MarkdownHtmlEmbedFrame frameTitle={frameTitle} url={currentState.url} />;
}

// 就绪态渲染：键盘可聚焦的滚动区承载沙箱 iframe。
function MarkdownHtmlEmbedFrame(props: { frameTitle: string; url: string }) {
  return (
    <>
      {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role -- A section is invalid inside a Markdown paragraph; this scroll region needs keyboard focus. */}
      <span className="mmd-html-embed-viewport" role="region" tabIndex={0} aria-label={props.frameTitle}>
        <iframe
          className="mmd-html-embed-frame"
          loading="eager"
          referrerPolicy="no-referrer"
          sandbox={MARKDOWN_HTML_EMBED_SANDBOX}
          src={props.url}
          title={props.frameTitle}
        />
      </span>
      {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role */}
    </>
  );
}

// 加载/失败状态输出：请求未落定显示启动中，失败显示不可用。
function HtmlEmbedStatusOutput(props: {
  currentState: import('./markdownHtmlEmbedLease').HtmlEmbedRequestState | null;
  requestKey: string | null;
  startingLabel: string;
  unavailableLabel: string;
}) {
  const busy = props.requestKey !== null && props.currentState?.status !== 'failed';
  return (
    <output className="mmd-html-embed-status" aria-busy={busy} aria-live="polite">
      {busy ? props.startingLabel : props.unavailableLabel}
    </output>
  );
}
