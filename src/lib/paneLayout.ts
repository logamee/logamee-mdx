import type { CSSProperties } from 'react';
import { translate } from './i18n';
import type { EffectiveLocale } from './locale';

export type PopoutPane = 'main' | 'editor' | 'preview';
export type PopoutCapablePane = Exclude<PopoutPane, 'main'>;

const MIN_EDITOR_RATIO = 0.25;
const MAX_EDITOR_RATIO = 0.75;
const POPOUT_INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function clampEditorPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_EDITOR_RATIO, Math.max(MIN_EDITOR_RATIO, ratio));
}

export function resizeEditorPaneRatio(input: { startRatio: number; deltaX: number; containerWidth: number }): number {
  if (!Number.isFinite(input.containerWidth) || input.containerWidth <= 0) return clampEditorPaneRatio(input.startRatio);
  return clampEditorPaneRatio(input.startRatio + input.deltaX / input.containerWidth);
}

export function resizeEditorPaneRatioFromKey(
  ratio: number,
  key: string,
  accelerated: boolean,
): number | null {
  if (key === 'Home') return 0.5;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const step = accelerated ? 0.08 : 0.02;
  return clampEditorPaneRatio(ratio + (key === 'ArrowRight' ? step : -step));
}

export function getPaneLayoutStyle(editorRatio: number): CSSProperties & Record<'--editor-pane-ratio' | '--preview-pane-ratio' | '--editor-pane-fr' | '--preview-pane-fr', string> {
  const clamped = clampEditorPaneRatio(editorRatio);
  const editor = Math.round(clamped * 10000) / 100;
  const preview = Math.round((1 - clamped) * 10000) / 100;
  return {
    '--editor-pane-ratio': `${editor}%`,
    '--preview-pane-ratio': `${preview}%`,
    '--editor-pane-fr': `${clamped}fr`,
    '--preview-pane-fr': `${1 - clamped}fr`,
  };
}

export function parsePopoutPane(search: string): PopoutPane {
  const pane = new URLSearchParams(search).get('pane');
  return pane === 'editor' || pane === 'preview' ? pane : 'main';
}

export function parsePopoutInstanceId(search: string): string | null {
  const instanceId = new URLSearchParams(search).get('instance');
  return instanceId && POPOUT_INSTANCE_ID_PATTERN.test(instanceId) ? instanceId : null;
}

export function getPanePopoutLabel(pane: PopoutCapablePane): string {
  return pane === 'editor' ? 'mmd-editor-popout' : 'mmd-preview-popout';
}

export function getPanePopoutUrl(pane: PopoutCapablePane, instanceId?: string): string {
  if (pane !== 'editor' || !instanceId || !POPOUT_INSTANCE_ID_PATTERN.test(instanceId)) {
    return `/?pane=${pane}`;
  }
  return `/?pane=${pane}&instance=${encodeURIComponent(instanceId)}`;
}

export interface PanePopoutButtonState {
  ariaLabel: string;
  title: string;
  statusLabel: string | null;
  isPoppedOut: boolean;
}

function paneDisplayName(pane: PopoutCapablePane, locale: EffectiveLocale): string {
  return pane === 'editor' ? translate(locale, 'editor') : translate(locale, 'livePreview');
}

export function getPanePopoutButtonState(pane: PopoutCapablePane, isPoppedOut: boolean, locale: EffectiveLocale = 'en'): PanePopoutButtonState {
  if (!isPoppedOut) {
    const label = pane === 'editor' ? translate(locale, 'popOutEditor') : translate(locale, 'popOutPreview');
    return {
      ariaLabel: label,
      title: label,
      statusLabel: null,
      isPoppedOut: false,
    };
  }
  const label = translate(locale, 'popoutOpen', { pane: paneDisplayName(pane, locale) });
  return {
    ariaLabel: label,
    title: label,
    statusLabel: translate(locale, 'poppedOut'),
    isPoppedOut: true,
  };
}
