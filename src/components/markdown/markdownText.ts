import React, { Children } from 'react';
import type { Element as HastElement } from 'hast';

export const BLOCKQUOTE_TREE_HEURISTIC_RE = /[\u2500-\u257F\u2580-\u259F]/;

export function isFenceCodeLike(hastCode: HastElement | undefined, classStr: string, body: string): boolean {
  if (/\blanguage-[^\s]+/i.test(classStr)) return true;
  if (/\r?\n/.test(body.replace(/\n$/, ''))) return true;
  const p = hastCode?.position;
  return typeof p?.start.line === 'number' && typeof p?.end.line === 'number' && p.end.line !== p.start.line;
}

export function hastCollectPlainText(node: unknown): string {
  if (node == null || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: unknown; children?: unknown[] };
  if (n.type === 'text' && typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) return n.children.map(hastCollectPlainText).join('');
  return '';
}

export function extractText(children: React.ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (React.isValidElement<{ children?: React.ReactNode }>(child)) return extractText(child.props.children);
    return '';
  }).join('');
}

export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[\s/]+/g, '-').replace(/[^\p{L}\p{N}\-_]+/gu, '').replace(/^-+|-+$/g, '');
}

export function paragraphIsSingleUrlLine(children: React.ReactNode): boolean {
  const parts = Children.toArray(children);
  if (parts.length !== 1) return false;
  const child = parts[0];
  if (typeof child === 'string' || typeof child === 'number') return /^\s*https?:\/\/\S+\s*$/i.test(String(child).trim());
  if (React.isValidElement<{ href?: string; children?: React.ReactNode }>(child) && child.type === 'a') return /^https?:\/\//i.test(child.props.href ?? '');
  return false;
}

export function paragraphLooksLikeTextDiagram(text: string): boolean {
  const compact = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return compact.length >= 24 && /[_\-—─━=]{6,}/.test(compact) && (/[→←↔↳↴↵⇄]|<->|-->|=>/.test(compact) || compact.split(/[_\-—─━=]{6,}/).filter((p) => p.trim().length > 1).length >= 2);
}
