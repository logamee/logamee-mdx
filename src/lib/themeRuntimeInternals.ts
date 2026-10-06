/* 主题运行时内部动作与生命周期构造器（上下文接口一并下沉）。 */
import {
  applyEffectiveTheme,
  DEFAULT_THEME_PREFERENCE,
  decodeSerializedThemePreference,
  decodeThemeSnapshotEnvelope,
  resolveEffectiveTheme,
  THEME_PROTOCOL_VERSION,
  THEME_SNAPSHOT_EVENT,
  THEME_STORAGE_KEY,
} from './theme';
import { decodeNativeThemeMenuIntent, NATIVE_MENU_EVENT } from './nativeMenu';
import type { CreateThemeRuntimeOptions, ThemeUnlisten } from './themeRuntimeTypes';
import type { EffectiveTheme, ThemePreference } from './theme';

function reportSafely(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // Reporting must not break theme application or listener cleanup.
  }
}

function preferencesEqual(left: ThemePreference, right: ThemePreference): boolean {
  return left.version === right.version
    && left.selectedSkin === right.selectedSkin
    && left.followSystem === right.followSystem;
}


export interface ThemeRuntimeContext {
  effectiveTheme: EffectiveTheme;
  preference: ThemePreference;
  revision: number;
  state: 'idle' | 'starting' | 'started' | 'stopped';
  synchronousListenersAttached: boolean;
  unlistenTheme: ThemeUnlisten | undefined;
  unlistenNativeMenu: ThemeUnlisten | undefined;
  nativeProjectionQueue: Promise<void>;
  startupProjectionReady: boolean;
  pendingStartupCommits: ThemePreference[];
  eventApi: CreateThemeRuntimeOptions['eventApi'];
  mediaQuery: CreateThemeRuntimeOptions['mediaQuery'];
  onError: ((error: unknown) => void) | undefined;
  role: 'main' | 'popout';
  root: CreateThemeRuntimeOptions['root'];
  storage: CreateThemeRuntimeOptions['storage'];
  storageEvents: CreateThemeRuntimeOptions['storageEvents'];
  syncNativePreference: CreateThemeRuntimeOptions['syncNativePreference'];
  isStopped(): boolean;
}


// 基础动作：偏好应用与修订化快照广播。
export function createThemeRuntimeActions(ctx: ThemeRuntimeContext): ThemeRuntimeActionsBundle {
  const applyPreference = (nextPreference: ThemePreference): void => {
    ctx.preference = nextPreference;
    ctx.effectiveTheme = resolveEffectiveTheme(nextPreference, ctx.mediaQuery.matches);
    applyEffectiveTheme(ctx.root, ctx.effectiveTheme);
  };
  const emitSnapshot = (snapshotPreference: ThemePreference): void => emitThemeSnapshot(ctx, snapshotPreference);
  const enqueueNativeProjection = (nextPreference: ThemePreference, broadcast: boolean): Promise<void> =>
    enqueueThemeNativeProjection(ctx, nextPreference, broadcast);
  const commitPreference = (nextPreference: ThemePreference): boolean =>
    commitThemePreference(ctx, nextPreference, { applyPreference, enqueueNativeProjection });
  return { applyPreference, commitPreference, enqueueNativeProjection, emitSnapshot };
}

// 快照广播：revision 溢出回卷后自增并发布给定偏好。
function emitThemeSnapshot(ctx: ThemeRuntimeContext, snapshotPreference: ThemePreference): void {
  if (ctx.revision >= Number.MAX_SAFE_INTEGER) ctx.revision = 0;
  ctx.revision += 1;
  const snapshot = {
    protocolVersion: THEME_PROTOCOL_VERSION,
    revision: ctx.revision,
    preference: snapshotPreference,
  } as const;
  void ctx.eventApi.emit(THEME_SNAPSHOT_EVENT, snapshot).catch((error: unknown) => {
    reportSafely(ctx.onError, error);
  });
}

// 原生投影队列：串行同步原生偏好；广播仅当期间偏好未被覆盖。
function enqueueThemeNativeProjection(
  ctx: ThemeRuntimeContext,
  nextPreference: ThemePreference,
  broadcast: boolean,
): Promise<void> {
  const capturedPreference = nextPreference;
  ctx.nativeProjectionQueue = ctx.nativeProjectionQueue.then(async () => {
    if (ctx.syncNativePreference) {
      try {
        await ctx.syncNativePreference(capturedPreference);
      } catch (error) {
        reportSafely(ctx.onError, error);
      }
    }
    if (broadcast && preferencesEqual(capturedPreference, ctx.preference)) {
      emitThemeSnapshot(ctx, capturedPreference);
    }
  });
  return ctx.nativeProjectionQueue;
}

// 偏好提交：持久化失败即中止；启动投影未就绪时挂起待冲刷。
function commitThemePreference(
  ctx: ThemeRuntimeContext,
  nextPreference: ThemePreference,
  actions: Pick<ThemeRuntimeActionsBundle, 'applyPreference' | 'enqueueNativeProjection'>,
): boolean {
  try {
    ctx.storage.setItem(THEME_STORAGE_KEY, JSON.stringify(nextPreference));
  } catch (error) {
    reportSafely(ctx.onError, error);
    return false;
  }
  actions.applyPreference(nextPreference);
  if (ctx.state === 'starting' && !ctx.startupProjectionReady) {
    ctx.pendingStartupCommits.push(nextPreference);
  } else {
    void actions.enqueueNativeProjection(nextPreference, true);
  }
  return true;
}

// 生命周期与事件：停止、监听注册与三类事件处理器（ctx 化）。
export function createThemeRuntimeLifecycle(ctx: ThemeRuntimeContext & ThemeRuntimeActionsBundle): ThemeRuntimeLifecycle {
  const handlers = createThemeRuntimeEventHandlers(ctx);
  const listeners = createThemeRuntimeListeners(ctx, handlers);
  const stop = createThemeRuntimeStop(ctx, handlers);
  return { ...handlers, ...listeners, stop };
}

// 三类事件处理器：系统主题变化、storage 同步与主/弹窗快照消费。
function createThemeRuntimeEventHandlers(ctx: ThemeRuntimeContext & ThemeRuntimeActionsBundle): ThemeRuntimeEventHandlers {
  const handleMediaChange = (event: { matches: boolean }): void => {
    ctx.effectiveTheme = resolveEffectiveTheme(ctx.preference, event.matches);
    applyEffectiveTheme(ctx.root, ctx.effectiveTheme);
  };

  const handleStorage = (event: { key: string | null; newValue: string | null }): void => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const decoded = decodeSerializedThemePreference(event.newValue);
    if (ctx.role === 'popout') {
      if (decoded) ctx.applyPreference(decoded);
      return;
    }
    ctx.commitPreference(decoded ?? DEFAULT_THEME_PREFERENCE);
  };

  const handleThemeEvent = (event: { payload: unknown }): void => {
    if (ctx.role === 'main') return;
    const snapshot = decodeThemeSnapshotEnvelope(event.payload);
    if (!snapshot || snapshot.revision <= ctx.revision) return;
    ctx.revision = snapshot.revision;
    ctx.applyPreference(snapshot.preference);
  };

  const handleNativeMenu = (event: { payload: unknown }): void => {
    if (ctx.role !== 'main') return;
    const intent = decodeNativeThemeMenuIntent(event.payload);
    if (!intent) return;
    const nextPreference = intent.type === 'select-theme-skin'
      ? { ...ctx.preference, selectedSkin: intent.selectedSkin }
      : { ...ctx.preference, followSystem: !ctx.preference.followSystem };
    ctx.commitPreference(nextPreference);
  };

  return { handleMediaChange, handleNativeMenu, handleStorage, handleThemeEvent };
}

// 事件监听注册：停止后到达的注销句柄立即释放。
function createThemeRuntimeListeners(
  ctx: ThemeRuntimeContext,
  handlers: ThemeRuntimeEventHandlers,
): ThemeRuntimeListeners {
  const register = async (
    event: string,
    handler: (event: { payload: unknown }) => void,
    adopt: (unlisten: ThemeUnlisten) => void,
  ): Promise<void> => {
    try {
      const registeredUnlisten = await ctx.eventApi.listen(event, handler);
      if (ctx.isStopped()) registeredUnlisten();
      else adopt(registeredUnlisten);
    } catch (error) {
      if (!ctx.isStopped()) reportSafely(ctx.onError, error);
    }
  };
  const registerThemeListener = () => register(THEME_SNAPSHOT_EVENT, handlers.handleThemeEvent, (fn) => { ctx.unlistenTheme = fn; });
  const registerNativeMenuListener = () => register(NATIVE_MENU_EVENT, handlers.handleNativeMenu, (fn) => { ctx.unlistenNativeMenu = fn; });
  return { registerNativeMenuListener, registerThemeListener };
}

// 停止：注销同步监听与两个事件监听。
function createThemeRuntimeStop(
  ctx: ThemeRuntimeContext,
  handlers: ThemeRuntimeEventHandlers,
): () => void {
  return () => {
    if (ctx.state === 'stopped') return;
    ctx.state = 'stopped';
    if (ctx.synchronousListenersAttached) {
      ctx.mediaQuery.removeEventListener('change', handlers.handleMediaChange);
      ctx.storageEvents.removeEventListener('storage', handlers.handleStorage);
      ctx.synchronousListenersAttached = false;
    }
    ctx.unlistenTheme?.();
    ctx.unlistenTheme = undefined;
    ctx.unlistenNativeMenu?.();
    ctx.unlistenNativeMenu = undefined;
  };
}

export interface ThemeRuntimeActionsBundle {
  applyPreference: (nextPreference: ThemePreference) => void;
  commitPreference: (nextPreference: ThemePreference) => boolean;
  emitSnapshot: (snapshotPreference: ThemePreference) => void;
  enqueueNativeProjection: (nextPreference: ThemePreference, broadcast: boolean) => Promise<void>;
}

interface ThemeRuntimeEventHandlers {
  handleMediaChange: (event: { matches: boolean }) => void;
  handleNativeMenu: (event: { payload: unknown }) => void;
  handleStorage: (event: { key: string | null; newValue: string | null }) => void;
  handleThemeEvent: (event: { payload: unknown }) => void;
}

interface ThemeRuntimeListeners {
  registerNativeMenuListener: () => Promise<void>;
  registerThemeListener: () => Promise<void>;
}

export interface ThemeRuntimeLifecycle extends ThemeRuntimeEventHandlers, ThemeRuntimeListeners {
  stop: () => void;
}
