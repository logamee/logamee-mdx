/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：租约效果依赖保持提取前原样，由 MarkdownHtmlFrame.test.tsx 回归约束 */
import { useEffect, useState } from 'react';
import { emitAppFeedbackError } from '../../lib/appFeedback';
import { prepareMarkdownHtmlEmbed, releaseMarkdownHtmlEmbed } from '../../lib/tauriCommands';

export type HtmlEmbedRequestState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'failed' }
  | { key: string; status: 'ready'; url: string };

// HTML 嵌入租约：按请求键申请本地预览租约，卸载或换键时释放。
export function useMarkdownHtmlEmbedLease(deps: {
  currentFilePath: string | null;
  htmlSrc: string;
  requestKey: string | null;
  workspaceRoot: string | null;
}): HtmlEmbedRequestState | null {
  const { currentFilePath, htmlSrc, requestKey, workspaceRoot } = deps;
  const [requestState, setRequestState] = useState<HtmlEmbedRequestState | null>(null);

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

  return requestState;
}
