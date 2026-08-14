import { getPanePopoutLabel, type PopoutCapablePane } from './paneLayout';
import { translate } from './i18n';
import type { EffectiveLocale } from './locale';

const PROGRAM_CLOSE_POPOUT_PANES: PopoutCapablePane[] = ['editor', 'preview'];

export interface UnsavedExitPrompt {
  title: string;
  message: string;
  saveLabel: string;
  cancelLabel: string;
  quitLabel: string;
}

function fileNameFromPath(path: string | null): string {
  return path?.split(/[\\/]/).pop() || 'Untitled.md';
}

export function shouldShowUnsavedExitPrompt(input: { dirty: boolean; isPopout: boolean }): boolean {
  return input.dirty && !input.isPopout;
}

export function shouldPreventDefaultProgramClose(input: { dirty: boolean; isPopout: boolean }): boolean {
  return shouldShowUnsavedExitPrompt(input);
}

export function shouldBlockProgramCloseOnPopoutCloseFailure(): boolean {
  return false;
}

export function getProgramClosePopoutLabels(): string[] {
  return PROGRAM_CLOSE_POPOUT_PANES.map(getPanePopoutLabel);
}

export function getUnsavedExitPrompt(activePath: string | null, locale: EffectiveLocale = 'zh-CN'): UnsavedExitPrompt {
  const name = fileNameFromPath(activePath);
  return {
    title: translate(locale, 'unsavedChanges'),
    message: translate(locale, 'unsavedExitMessage', { name }),
    saveLabel: translate(locale, 'save'),
    cancelLabel: translate(locale, 'cancel'),
    quitLabel: translate(locale, 'quitApp'),
  };
}

export function getUnsavedFileSwitchPrompt(
  activePath: string | null,
  targetPath: string,
  locale: EffectiveLocale = 'zh-CN',
): UnsavedExitPrompt {
  const name = fileNameFromPath(activePath);
  const target = fileNameFromPath(targetPath);
  return {
    title: translate(locale, 'unsavedChanges'),
    message: translate(locale, 'unsavedSwitchMessage', { name, target }),
    saveLabel: translate(locale, 'saveAndSwitch'),
    cancelLabel: translate(locale, 'cancel'),
    quitLabel: translate(locale, 'switchWithoutSaving'),
  };
}
