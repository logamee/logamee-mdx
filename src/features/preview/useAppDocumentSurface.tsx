import { useCallback, useDeferredValue, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DocxPreviewFeedback } from './DocxPreview';
import type { PdfPreviewFeedback } from './PdfPreview';
import { DocxPreview, PdfPreview } from './previewWrappers';
import { extractMarkdownOutline } from '../../lib/markdownOutline';
import { getWorkspacePresentation } from '../../lib/workspaceFileKind';
import type { DocumentAuthorityStatus } from '../../lib/documentSession';
import type { EffectiveLocale } from '../../lib/locale';
import type { WorkspaceFileEntry, WorkspaceFileKind } from '../../types';

export interface AppDocumentSurfaceDeps {
  activeFileKind: WorkspaceFileKind;
  activeMimeType: string | null;
  activePath: string | null;
  authorityStatus: DocumentAuthorityStatus;
  bytesBase64: string | null;
  content: string;
  documentEpoch: number;
  documentId: string;
  files: WorkspaceFileEntry[];
  locale: EffectiveLocale;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  translate: (key: 'loadingPdf' | 'loadingDocx') => string;
  workspaceRoot: string | null;
  workspaceToken: string | null;
}

// 当前文档的呈现面：文件类型标志、大纲、工作区文件关联与 PDF/DOCX 预览元素。
export function useAppDocumentSurface(deps: AppDocumentSurfaceDeps) {
  const { activeFileKind, activePath, files } = deps;
  const activePresentation = useMemo(
    () => getWorkspacePresentation(activeFileKind),
    [activeFileKind]);
  const deferredOutlineContent = useDeferredValue(deps.content);
  const outlineItems = useMemo(() => (
    activeFileKind === 'markdown' ? extractMarkdownOutline(deferredOutlineContent) : []
  ), [activeFileKind, deferredOutlineContent]);
  const activeWorkspaceMarkdownFile = useMemo(() => (
    activeFileKind === 'markdown'
      ? files.find((file) => file.path === activePath && file.kind === 'markdown') ?? null
      : null
  ), [activeFileKind, activePath, files]);
  const { setError, setNotice } = deps;
  const handleDocumentPreviewFeedback = useDocumentPreviewFeedback(setError, setNotice);
  const handleExcalidrawError = useCallback((message: string) => {
    setError(message);
    setNotice(null);
  }, [setError, setNotice]);
  const documentPreview = buildDocumentPreview(deps, handleDocumentPreviewFeedback);

  const isImageFile = activePresentation.preview === 'image';
  const isMediaFile = activePresentation.preview === 'media';
  const isPdfFile = activePresentation.preview === 'pdf';
  const isDocxFile = activePresentation.preview === 'docx';
  const mediaKind = isMediaFile ? activePresentation.media_kind : 'video';

  return {
    activePresentation,
    activeWorkspaceMarkdownFile,
    documentAssetsEnabled: deps.authorityStatus === 'committed',
    documentPreview,
    editorFileKind: 'editor' in activePresentation ? activePresentation.editor : 'markdown',
    handleExcalidrawError,
    isDocumentFile: isPdfFile || isDocxFile,
    isExcalidrawFile: activePresentation.preview === 'excalidraw',
    isImageFile,
    isMediaFile,
    mediaKind,
    mediaMimeType: deps.activeMimeType ?? (mediaKind === 'audio' ? 'audio/*' : 'video/*'),
    outlineItems };
}

function useDocumentPreviewFeedback(
  setError: (message: string | null) => void,
  setNotice: (message: string | null) => void,
) {
  return useCallback((feedback: DocxPreviewFeedback | PdfPreviewFeedback) => {
    if (feedback.kind === 'error') {
      setError(feedback.message);
      setNotice(null);
    } else {
      setNotice(feedback.message);
      setError(null);
    }
  }, [setError, setNotice]);
}

function buildDocumentPreview(
  deps: AppDocumentSurfaceDeps,
  onFeedback: (feedback: DocxPreviewFeedback | PdfPreviewFeedback) => void,
): ReactNode {
  const previewProps = {
    bytesBase64: deps.bytesBase64,
    documentEpoch: deps.documentEpoch,
    documentId: deps.documentId,
    enabled: deps.authorityStatus === 'committed',
    locale: deps.locale,
    onFeedback };
  if (deps.activeFileKind === 'pdf') {
    return <PdfPreview {...previewProps} loadingLabel={deps.translate('loadingPdf')} />;
  }
  if (deps.activeFileKind === 'docx') {
    return <DocxPreview {...previewProps} loadingLabel={deps.translate('loadingDocx')} />;
  }
  return null;
}
