import {
  applyEffectiveTheme,
  decodeThemePreference,
  DEFAULT_THEME_PREFERENCE,
  resolveEffectiveTheme,
  type ThemePreference,
} from './theme';
import {
  createThemeRuntimeActions,
  createThemeRuntimeLifecycle,
  type ThemeRuntimeActionsBundle,
  type ThemeRuntimeContext,
  type ThemeRuntimeLifecycle,
} from './themeRuntimeInternals';

export type {
  CreateThemeRuntimeOptions,
  ThemeEventApi,
  ThemeMediaQuery,
  ThemeRuntimeRole,
  ThemeStorageEventSource,
  ThemeUnlisten,
} from './themeRuntimeTypes';
import type { CreateThemeRuntimeOptions, ThemeRuntimeSnapshot, ThemeUnlisten } from './themeRuntimeTypes';
export interface ThemeRuntime {
  start(): Promise<void>;
  stop(): void;
  setPreference(value: unknown): boolean;
  getSnapshot(): ThemeRuntimeSnapshot;
}


export function createThemeRuntime(options: CreateThemeRuntimeOptions): ThemeRuntime {
  const ctx = createThemeRuntimeContext(options);

  return {
    async start(): Promise<void> {
      if (ctx.state !== 'idle') return;
      ctx.state = 'starting';
      const startupPreference = ctx.preference;
      ctx.mediaQuery.addEventListener('change', ctx.handleMediaChange);
      ctx.storageEvents.addEventListener('storage', ctx.handleStorage);
      ctx.synchronousListenersAttached = true;

      if (ctx.role === 'main') await ctx.registerNativeMenuListener();
      if (ctx.isStopped()) return;
      if (ctx.role === 'main' && ctx.syncNativePreference) {
        const startupProjection = ctx.enqueueNativeProjection(startupPreference, false);
        ctx.startupProjectionReady = true;
        for (const pendingPreference of ctx.pendingStartupCommits.splice(0)) {
          void ctx.enqueueNativeProjection(pendingPreference, true);
        }
        await startupProjection;
      }
      if (ctx.isStopped()) return;
      await ctx.registerThemeListener();
      if (!ctx.isStopped()) ctx.state = 'started';
    },
    stop: ctx.stop,
    setPreference(value: unknown): boolean {
      if (ctx.role !== 'main') return false;
      const nextPreference = decodeThemePreference(value);
      return nextPreference ? ctx.commitPreference(nextPreference) : false;
    },
    getSnapshot(): ThemeRuntimeSnapshot {
      return { preference: ctx.preference, effectiveTheme: ctx.effectiveTheme, revision: ctx.revision };
    },
  };
}

// 主题运行时上下文：可变状态束 + 应用/写入/事件处理器与监听注册。
function createThemeRuntimeContext(options: CreateThemeRuntimeOptions): ThemeRuntimeContext & ThemeRuntimeActionsBundle & ThemeRuntimeLifecycle {
  const { role, root, storage, mediaQuery, storageEvents, eventApi, onError, syncNativePreference } = options;
  const revisionSeed = options.revisionSeed ?? (role === 'main' ? Date.now() : 0);
  const ctx: ThemeRuntimeContext = {
    effectiveTheme: resolveEffectiveTheme(
      decodeThemePreference(options.initialPreference) ?? DEFAULT_THEME_PREFERENCE,
      mediaQuery.matches,
    ),
    preference: decodeThemePreference(options.initialPreference) ?? DEFAULT_THEME_PREFERENCE,
    revision: Number.isSafeInteger(revisionSeed) && revisionSeed >= 0 ? revisionSeed : 0,
    state: 'idle' as 'idle' | 'starting' | 'started' | 'stopped',
    synchronousListenersAttached: false,
    unlistenTheme: undefined as ThemeUnlisten | undefined,
    unlistenNativeMenu: undefined as ThemeUnlisten | undefined,
    nativeProjectionQueue: Promise.resolve(),
    startupProjectionReady: role !== 'main' || !syncNativePreference,
    pendingStartupCommits: [] as ThemePreference[],
    eventApi,
    mediaQuery,
    onError,
    role,
    root,
    storage,
    storageEvents,
    syncNativePreference,
    isStopped(): boolean { return ctx.state === 'stopped'; },
  };
  applyEffectiveTheme(root, ctx.effectiveTheme);
  const actions = createThemeRuntimeActions(ctx);
  const lifecycle = createThemeRuntimeLifecycle(ctx as ThemeRuntimeContext & ThemeRuntimeActionsBundle);
  return Object.assign(ctx, actions, lifecycle) as ThemeRuntimeContext & ThemeRuntimeActionsBundle & ThemeRuntimeLifecycle;
}
