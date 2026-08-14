import { useEffect, useRef, type Ref, type ReactNode } from 'react';
import type { MarkdownOutlineJump } from '../lib/markdownOutline';
import type { PanePopoutButtonState } from '../lib/paneLayout';
import { PaneHeader } from './PaneHeader';
import { useI18n } from '../lib/i18n';

interface PreviewPaneProps {
  children: ReactNode;
  dirty: boolean;
  outlineJump?: MarkdownOutlineJump | null;
  onPopout?: () => void;
  paneRef?: Ref<HTMLElement>;
  popoutButton?: PanePopoutButtonState;
  popout?: boolean;
}

function findOutlineHeading(
  viewport: HTMLElement,
  outlineJump: MarkdownOutlineJump,
): HTMLElement | null {
  return viewport.querySelector<HTMLElement>(
    `h${outlineJump.item.level}[data-heading-line="${outlineJump.item.line}"]`,
  );
}

export function PreviewPane({ children, dirty, outlineJump, onPopout, paneRef, popoutButton, popout = false }: PreviewPaneProps) {
  const { t } = useI18n();
  const previewScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!outlineJump || !previewScrollRef.current) return undefined;
    const viewport = previewScrollRef.current;
    const scrollToHeading = () => {
      const heading = findOutlineHeading(viewport, outlineJump);
      if (!heading) return false;
      heading.scrollIntoView({ block: 'start' });
      return true;
    };

    if (scrollToHeading() || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      if (scrollToHeading()) observer.disconnect();
    });
    observer.observe(viewport, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [outlineJump]);

  return (
    <section className={popout ? 'preview-pane popout-pane' : 'preview-pane'} ref={paneRef}>
      <PaneHeader title={t('livePreview')} subtitle={dirty ? t('modified') : t('synced')} popoutButton={popoutButton} onPopout={onPopout} />
      <div className="preview-scroll" ref={previewScrollRef}>{children}</div>
    </section>
  );
}
