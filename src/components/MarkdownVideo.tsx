import { useCallback, useEffect, useRef, useState } from 'react';
import { emitAppFeedbackError } from '../lib/appFeedback';
import { useI18n } from '../lib/i18n';
import { prepareMarkdownMediaPreview, releaseMediaPreview } from '../lib/tauriCommands';
import { VideoPlayer } from './VideoPlayer';

const REMOTE_OR_DATA_RE = /^(?:https?:)?\/\//i;
function isLoopbackHttpUrl(src: string): boolean {
  const normalizedSource = src.trim().toLowerCase();
  if (normalizedSource.includes('://[::1]')) return true;
  try {
    const url = new URL(normalizedSource);
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (hostname === 'localhost'
        || hostname.startsWith('127.')
        || hostname === '[::1]'
        || hostname === '::1'
        || hostname === '0.0.0.0');
  } catch {
    return false;
  }
}

function shouldResolveLocally(src: string): boolean {
  const trimmed = src.trim();
  return !!trimmed && !REMOTE_OR_DATA_RE.test(trimmed) && !/^data:/i.test(trimmed) && !/^file:/i.test(trimmed) && !trimmed.startsWith('/');
}

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
  const { locale, t } = useI18n();
  const loopbackSource = isLoopbackHttpUrl(src)
    || /^\s*https?:\/\/(?:localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|0\.0\.0\.0|\[::1\])(?::|\/)/iu.test(src);
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(() => (
    loopbackSource || (shouldResolveLocally(src) && currentFilePath && !localAssetsEnabled) ? undefined : src
  ));
  const [failed, setFailed] = useState(false);
  const ownerIdRef = useRef<number | null>(null);
  const handleError = useCallback(() => {
    setFailed(true);
    emitAppFeedbackError('Failed to play Markdown video');
  }, []);
  const handleLoaded = useCallback(() => setFailed(false), []);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (!src) {
      setResolvedSrc(undefined);
      return undefined;
    }
    if (loopbackSource) {
      setResolvedSrc(undefined);
      setFailed(true);
      return undefined;
    }
    if (!currentFilePath || !shouldResolveLocally(src)) {
      setResolvedSrc(src);
      return undefined;
    }
    if (!localAssetsEnabled) {
      setResolvedSrc(undefined);
      return undefined;
    }
    prepareMarkdownMediaPreview(currentFilePath, src, workspaceRoot)
      .then((lease) => {
        if (cancelled) {
          void releaseMediaPreview(lease.ownerId).catch(() => undefined);
          return;
        }
        ownerIdRef.current = lease.ownerId;
        setResolvedSrc(lease.url);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setResolvedSrc(undefined);
        setFailed(true);
        emitAppFeedbackError(error);
      });
    return () => {
      cancelled = true;
      const ownerId = ownerIdRef.current;
      ownerIdRef.current = null;
      if (ownerId !== null) void releaseMediaPreview(ownerId).catch(() => undefined);
    };
  }, [currentFilePath, localAssetsEnabled, locale, loopbackSource, src, workspaceRoot]);

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
