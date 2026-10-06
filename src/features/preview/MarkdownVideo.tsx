import { useI18n } from '../../lib/i18n';
import { useMarkdownVideoSource } from './markdownVideoSource';
import { VideoPlayer } from './VideoPlayer';

export function isMarkdownVideoSource(src: string): boolean {
  const path = src.trim().split(/[?#]/u, 1)[0] ?? '';
  return /\.(?:3g2|3gp|asf|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ogv|vob|webm|wmv)$/iu.test(path);
}

interface Props {
  alt?: string;
  className?: string;
  currentFilePath: string | null;
  localAssetsEnabled?: boolean;
  src: string;
  title?: string;
  workspaceRoot: string | null;
}

export function MarkdownVideo({ alt = '', className, currentFilePath, localAssetsEnabled = true, src, title, workspaceRoot }: Props) {
  const { t } = useI18n();
  const { failed, handleError, handleLoaded, resolvedSrc } = useMarkdownVideoSource({
    currentFilePath, localAssetsEnabled, src, workspaceRoot,
  });

  if (failed) {
    return <span className="media-error" aria-label={t('mediaLoadFailed')}>{t('mediaLoadFailed')}</span>;
  }
  if (!resolvedSrc) {
    return <output className="markdown-video-status" aria-busy="true">{t('loadingMedia')}</output>;
  }
  return (
    <VideoPlayer
      ariaLabel={alt || title || undefined}
      className={['jinxiu-markdown-video', className].filter(Boolean).join(' ') || undefined}
      onError={handleError}
      onLoaded={handleLoaded}
      path={src}
      sourceUrl={resolvedSrc}
    />
  );
}
