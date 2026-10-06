/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：行为由 App.media 回归约束 */
import { emitTo } from '@tauri-apps/api/event';
export interface MarkdownMediaRetryController {
  cancelled: boolean;
  pendingTimers: Map<ReturnType<typeof globalThis.setTimeout>, () => void>;
}

export const MEDIA_EVENT_RETRY_DELAYS_MS = [0, 100, 250] as const;


export function createMarkdownMediaRetryController(): MarkdownMediaRetryController {
  return { cancelled: false, pendingTimers: new Map() };
}

export function cancelMarkdownMediaRetries(controller: MarkdownMediaRetryController): void {
  controller.cancelled = true;
  for (const [timer, resolve] of controller.pendingTimers) {
    globalThis.clearTimeout(timer);
    resolve();
  }
  controller.pendingTimers.clear();
}

function waitForRetry(
  delayMs: number,
  controller: MarkdownMediaRetryController | undefined,
): Promise<boolean> {
  if (controller?.cancelled) return Promise.resolve(false);
  return new Promise((resolve) => {
    const complete = () => resolve(!controller?.cancelled);
    const timer = globalThis.setTimeout(() => {
      controller?.pendingTimers.delete(timer);
      complete();
    }, delayMs);
    controller?.pendingTimers.set(timer, complete);
  });
}


// 重试是否已被放弃：控制器取消或目标不再是当前面板。
function retryAbandoned(
  controller: MarkdownMediaRetryController | undefined,
  isCurrent: () => boolean,
): boolean {
  return Boolean(controller?.cancelled) || !isCurrent();
}

export async function emitToWithRetry(
  target: string,
  event: string,
  payload: unknown,
  isCurrent: () => boolean,
  retryController?: MarkdownMediaRetryController,
): Promise<void> {
  let lastError: unknown;
  for (const delayMs of MEDIA_EVENT_RETRY_DELAYS_MS) {
    if (delayMs > 0 && !await waitForRetry(delayMs, retryController)) return;
    if (retryAbandoned(retryController, isCurrent)) return;
    try {
      await emitTo(target, event, payload);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  if (!retryAbandoned(retryController, isCurrent)) throw lastError;
}
