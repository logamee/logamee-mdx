import DOMPurify from 'dompurify';
import type { SkinId } from './theme';

export type ExportThemeChoice = 'light' | 'dark' | 'current';

export interface OfflineHtmlExportInput {
  title: string;
  bodyHtml: string;
  themeCss: string;
  theme: ExportThemeChoice;
  skin: SkinId;
  assetDataUrls?: Readonly<Record<string, string>>;
  extraCss?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

function inlineAssets(html: string, assets: Readonly<Record<string, string>>): string {
  return html.replace(/\s(?:src|href)=(['"])([^'"]+)\1/giu, (full, quote: string, source: string) => {
    const replacement = assets[source];
    return replacement ? full.replace(`${quote}${source}${quote}`, `${quote}${replacement}${quote}`) : full;
  });
}

export function buildOfflineHtml(input: OfflineHtmlExportInput): string {
  const safeBody = DOMPurify.sanitize(inlineAssets(input.bodyHtml, input.assetDataUrls ?? {}), {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_ATTR: ['target', 'rel', 'class', 'style'],
  });
  const safeTitle = escapeHtml(input.title || 'mdx export');
  const themeClass = input.theme === 'dark' ? 'dark' : 'light';
  const css = `${input.themeCss}\n${input.extraCss ?? ''}`;
  const linksSafe = safeBody.replace(/<a\b([^>]*href=(['"])(?:https?:\/\/|\/\/)[^'"]*\2[^>]*)>/giu, (match) => {
    const withoutUnsafe = match.replace(/\s(?:target|rel)=(['"])[^'"]*\1/giu, '');
    return withoutUnsafe.replace(/>$/u, ' target="_blank" rel="noopener noreferrer">');
  });
  return `<!doctype html><html lang="en" class="${themeClass}" data-appearance="${themeClass}" data-skin="${input.skin}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${css.replace(/<\/style/giu, '<\\/style')}</style></head><body><main class="typora-jinxiu mmd-preview-content">${linksSafe}</main></body></html>`;
}
