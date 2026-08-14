import { useSyncExternalStore } from 'react';
import { isSkinId, type EffectiveTheme } from './theme';

export interface ObservedEffectiveTheme extends EffectiveTheme {
  readonly revision: number;
}

const FALLBACK_THEME: ObservedEffectiveTheme = Object.freeze({
  appearance: 'light',
  revision: 0,
  skin: 'original',
});

let snapshot = FALLBACK_THEME;
let snapshotKey = '';
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function readRootTheme(): Omit<ObservedEffectiveTheme, 'revision'> {
  if (typeof document === 'undefined') return FALLBACK_THEME;
  const root = document.documentElement;
  const skinValue = root.getAttribute('data-skin');
  const skin = isSkinId(skinValue) ? skinValue : 'original';
  const appearanceValue = root.getAttribute('data-appearance');
  const appearance = appearanceValue === 'dark' || appearanceValue === 'light'
    ? appearanceValue
    : skin === 'shanshui-yemo' ? 'dark' : 'light';
  return { appearance, skin };
}

function refreshSnapshot(notify: boolean): void {
  const theme = readRootTheme();
  const nextKey = `${theme.skin}:${theme.appearance}`;
  if (nextKey === snapshotKey) return;
  snapshotKey = nextKey;
  snapshot = Object.freeze({ ...theme, revision: snapshot.revision + 1 });
  if (notify) listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  refreshSnapshot(false);
  if (listeners.size === 1 && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => refreshSnapshot(true));
    observer.observe(document.documentElement, {
      attributeFilter: ['data-appearance', 'data-skin'],
      attributes: true,
    });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

function getSnapshot(): ObservedEffectiveTheme {
  refreshSnapshot(false);
  return snapshot;
}

export function useObservedEffectiveTheme(): ObservedEffectiveTheme {
  return useSyncExternalStore(subscribe, getSnapshot, () => FALLBACK_THEME);
}
