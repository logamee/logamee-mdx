import type { WorkspaceFileKind } from '../types';
import type { DocumentAuthorityStatus } from './documentSession';
import { isLocaleMode, type LocaleMode } from './locale';
import { isSkinId, type SkinId } from './theme';

export const NATIVE_MENU_EVENT = 'mmd-native-menu';

export const NATIVE_MENU_ACTIONS = [
  'new',
  'open-file',
  'open-directory',
  'quick-open',
  'workspace-search',
  'save',
  'save-as',
] as const;

export type NativeMenuAction = (typeof NATIVE_MENU_ACTIONS)[number];
export type NativeMenuCommand = NativeMenuAction
  | { type: 'open-recent'; entryId: string }
  | { type: 'clear-recent-files' };
export type NativeThemeMenuIntent =
  | { type: 'select-theme-skin'; selectedSkin: SkinId }
  | { type: 'toggle-theme-follow-system' };
export type NativeLocaleMenuIntent = { type: 'select-locale-mode'; mode: LocaleMode };

interface NativeSaveMenuContext {
  readonly authorityStatus: DocumentAuthorityStatus;
  readonly busy: boolean;
  readonly fileKind: WorkspaceFileKind;
}

export function isNativeSaveMenuEnabled({
  authorityStatus,
  busy,
  fileKind,
}: NativeSaveMenuContext): boolean {
  return authorityStatus === 'committed'
    && !busy
    && (fileKind === 'markdown' || fileKind === 'html' || fileKind === 'excalidraw');
}

export function isNativeMenuAction(value: unknown): value is NativeMenuAction {
  return typeof value === 'string' && (NATIVE_MENU_ACTIONS as readonly string[]).includes(value);
}

export function decodeNativeMenuCommand(value: unknown): NativeMenuCommand | null {
  if (isNativeMenuAction(value)) return value;
  if (value === 'clear-recent-files') return { type: 'clear-recent-files' };
  if (typeof value !== 'string') return null;
  const entryId = value.match(/^open-recent:([0-9a-f]{32})$/)?.[1];
  return entryId ? { type: 'open-recent', entryId } : null;
}

export function decodeNativeThemeMenuIntent(value: unknown): NativeThemeMenuIntent | null {
  if (value === 'theme-follow-system') return { type: 'toggle-theme-follow-system' };
  if (typeof value !== 'string') return null;
  const selectedSkin = value.match(/^theme-skin:([a-z-]+)$/)?.[1];
  return isSkinId(selectedSkin)
    ? { type: 'select-theme-skin', selectedSkin }
    : null;
}

export function decodeNativeLocaleMenuIntent(value: unknown): NativeLocaleMenuIntent | null {
  if (typeof value !== 'string') return null;
  const mode = value.match(/^locale:(system|zh-CN|en)$/)?.[1];
  return isLocaleMode(mode) ? { type: 'select-locale-mode', mode } : null;
}
