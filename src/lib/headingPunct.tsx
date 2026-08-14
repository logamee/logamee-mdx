import { Children } from 'react';
import type React from 'react';

export const JINXIU_HEADING_SYMBOL_SPLIT = /(■|▪)/;
export const JINXIU_HEADING_PUNCT_CLASS = 'jinxiu-h2-punct';

export function wrapPlainTextWithJinxiuHeadingPunct(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (!JINXIU_HEADING_SYMBOL_SPLIT.test(text)) return [text];
  text.split(JINXIU_HEADING_SYMBOL_SPLIT).forEach((part, index) => {
    if (part === '■' || part === '▪') {
      out.push(<span key={`${keyPrefix}-${index}`} className={JINXIU_HEADING_PUNCT_CLASS}>{part}</span>);
    } else if (part !== '') {
      out.push(part);
    }
  });
  return out;
}

export function mapH2ChildrenWrapHeadingSymbols(children: React.ReactNode): React.ReactNode {
  const out: React.ReactNode[] = [];
  Children.forEach(children, (child, idx) => {
    if (typeof child === 'string') out.push(...wrapPlainTextWithJinxiuHeadingPunct(child, `h2-${idx}`));
    else out.push(child);
  });
  return out;
}
