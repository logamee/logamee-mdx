import { normalizeAppError } from './appFeedback';
import { translate } from './i18n';
import type { EffectiveLocale } from './locale';
import type { PopoutCapablePane } from './paneLayout';

const PANE_NAMES: Record<PopoutCapablePane, string> = {
  editor: 'Editor',
  preview: 'Live Preview',
};

export function getPopoutOpenErrorMessage(pane: PopoutCapablePane, error: unknown, locale: EffectiveLocale = 'zh-CN'): string {
  const normalized = normalizeAppError(error, locale);
  const permissionFailure = normalizeAppError('permission denied', locale);
  const detail = normalized === permissionFailure
    ? normalized
    : normalizeAppError('webview window communication failed', locale);
  return translate(locale, 'popoutOpenFailed', {
    detail,
    pane: PANE_NAMES[pane],
  });
}
