export const SHORTCUT_ACTIONS = [
  'save',
  'saveAs',
  'quickOpen',
  'workspaceSearch',
  'export',
  'settings',
] as const;

export type ShortcutAction = typeof SHORTCUT_ACTIONS[number];

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  save: 'Mod+S',
  saveAs: 'Mod+Shift+S',
  quickOpen: 'Mod+P',
  workspaceSearch: 'Mod+Shift+F',
  export: 'Mod+Shift+E',
  settings: 'Mod+,',
};

const MODIFIER_ALIASES: Record<string, 'Mod' | 'Ctrl' | 'Alt' | 'Shift'> = {
  alt: 'Alt',
  option: 'Alt',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  command: 'Mod',
  cmd: 'Mod',
  meta: 'Mod',
  mod: 'Mod',
  shift: 'Shift',
};
const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

export function normalizeShortcut(value: string): string {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error('Shortcut requires a modifier and key');
  const keyParts: string[] = [];
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) modifiers.add(modifier);
    else keyParts.push(part);
  }
  if (modifiers.size === 0 || keyParts.length !== 1) throw new Error('Shortcut must contain exactly one key');
  const rawKey = keyParts[0];
  if (rawKey.length > 1 && !/^(?:F(?:[1-9]|1[0-2])|Enter|Escape|Space|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right))$/i.test(rawKey)) {
    throw new Error('Shortcut key is not supported');
  }
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey[0].toUpperCase() + rawKey.slice(1).toLowerCase();
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

export function resolveShortcutProfile(overrides: Record<string, string>): Record<ShortcutAction, string> {
  for (const action of Object.keys(overrides)) {
    if (!(SHORTCUT_ACTIONS as readonly string[]).includes(action)) throw new Error(`Unknown shortcut action: ${action}`);
  }
  return Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [
    action,
    normalizeShortcut(overrides[action] ?? DEFAULT_SHORTCUTS[action]),
  ])) as Record<ShortcutAction, string>;
}

export interface ShortcutConflict {
  shortcut: string;
  actions: ShortcutAction[];
}

export function findShortcutConflicts(profile: Record<string, string>): ShortcutConflict[] {
  const resolved = resolveShortcutProfile(profile);
  const grouped = new Map<string, ShortcutAction[]>();
  for (const action of SHORTCUT_ACTIONS) {
    const shortcut = resolved[action];
    grouped.set(shortcut, [...(grouped.get(shortcut) ?? []), action]);
  }
  return [...grouped.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([shortcut, actions]) => ({ shortcut, actions: actions.sort() }));
}

interface ShortcutKeyEvent {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export function shortcutMatchesEvent(shortcut: string, event: ShortcutKeyEvent, platform = navigator.platform): boolean {
  const normalized = normalizeShortcut(shortcut).split('+');
  const key = normalized[normalized.length - 1]?.toLowerCase();
  const isMac = platform.toLowerCase().includes('mac');
  return event.key.toLowerCase() === key
    && event.metaKey === (normalized.includes('Mod') && isMac)
    && event.ctrlKey === (normalized.includes('Ctrl') || (normalized.includes('Mod') && !isMac))
    && event.altKey === normalized.includes('Alt')
    && event.shiftKey === normalized.includes('Shift');
}
