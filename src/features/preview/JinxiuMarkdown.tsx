import { useDeferredValue, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import remarkGithubAlerts from 'remark-github-alerts';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { ExcalidrawAssetSyncOptions } from '../../lib/excalidrawAssetSync';
import { preprocessMarkdown } from '../../lib/markdownPreprocess';
import { rehypeMarkdownHtmlEmbeds } from '../../lib/markdownHtmlEmbed';
import { buildJinxiuComponents } from './jinxiuMarkdownComponents';

interface Props {
  children: string;
  currentFilePath: string | null;
  documentRelativePath?: string | null;
  excalidrawAssetSync?: ExcalidrawAssetSyncOptions | null;
  localAssetsEnabled?: boolean;
  memeImagesEnabled?: boolean;
  workspaceRoot: string | null;
}

export default function JinxiuMarkdown({
  children,
  currentFilePath,
  documentRelativePath = null,
  excalidrawAssetSync = null,
  localAssetsEnabled = true,
  memeImagesEnabled = false,
  workspaceRoot,
}: Props) {
  const deferredDocument = useDeferredValue(useMemo(() => ({
    children,
    currentFilePath,
    documentRelativePath,
    excalidrawAssetSync,
    localAssetsEnabled,
    memeImagesEnabled,
    workspaceRoot,
  }), [children, currentFilePath, documentRelativePath, excalidrawAssetSync, localAssetsEnabled, memeImagesEnabled, workspaceRoot]));
  const source = useMemo(() => preprocessMarkdown(deferredDocument.children), [deferredDocument.children]);
  const deferredCurrentFilePath = deferredDocument.currentFilePath;
  const deferredDocumentRelativePath = deferredDocument.documentRelativePath;
  const deferredExcalidrawAssetSync = deferredDocument.excalidrawAssetSync;
  const deferredLocalAssetsEnabled = deferredDocument.localAssetsEnabled;
  const deferredMemeImagesEnabled = deferredDocument.memeImagesEnabled;
  const deferredWorkspaceRoot = deferredDocument.workspaceRoot;
  const components = useMemo(() => buildJinxiuComponents({
    currentFilePath: deferredCurrentFilePath,
    documentRelativePath: deferredDocumentRelativePath,
    excalidrawAssetSync: deferredExcalidrawAssetSync,
    localAssetsEnabled: deferredLocalAssetsEnabled,
    memeImagesEnabled: deferredMemeImagesEnabled,
    workspaceRoot: deferredWorkspaceRoot,
  }), [deferredCurrentFilePath, deferredDocumentRelativePath, deferredExcalidrawAssetSync, deferredLocalAssetsEnabled, deferredMemeImagesEnabled, deferredWorkspaceRoot]);

  return (
    <div className="typora-jinxiu mmd-preview-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkMath, remarkGithubAlerts] as never}
        rehypePlugins={[rehypeMarkdownHtmlEmbeds, [rehypeKatex, { throwOnError: false, strict: false }]] as never}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
