export interface DocumentSessionQueueOperation<T> {
  run: () => T | Promise<T>;
  consume?: (value: T) => void | Promise<void>;
  isCurrent?: () => boolean;
  apply?: (value: T) => void | Promise<void>;
}

export type DocumentSessionQueueResult<T> =
  | { status: 'applied'; value: T }
  | { status: 'discarded'; value: T };

export interface DocumentSessionQueue {
  readonly busy: boolean;
  enqueue<T>(
    operation: DocumentSessionQueueOperation<T>,
  ): Promise<DocumentSessionQueueResult<T>>;
  subscribeBusy(listener: (busy: boolean) => void): () => void;
}

class FifoDocumentSessionQueue implements DocumentSessionQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private readonly busyListeners = new Set<(busy: boolean) => void>();

  get busy(): boolean {
    return this.pendingCount > 0;
  }

  enqueue<T>(
    operation: DocumentSessionQueueOperation<T>,
  ): Promise<DocumentSessionQueueResult<T>> {
    const wasIdle = this.pendingCount === 0;
    this.pendingCount += 1;

    const result = this.tail.then(async () => {
      const value = await operation.run();
      await operation.consume?.(value);
      if (operation.isCurrent && !operation.isCurrent()) {
        return { status: 'discarded', value } as const;
      }
      await operation.apply?.(value);
      return { status: 'applied', value } as const;
    });

    const trackedResult = result.finally(() => {
      this.pendingCount -= 1;
      if (this.pendingCount === 0) this.publishBusy(false);
    });
    this.tail = trackedResult.then(
      () => undefined,
      () => undefined,
    );

    if (wasIdle) this.publishBusy(true);
    return trackedResult;
  }

  subscribeBusy(listener: (busy: boolean) => void): () => void {
    this.busyListeners.add(listener);
    this.notifyBusyListener(listener, this.busy);
    return () => {
      this.busyListeners.delete(listener);
    };
  }

  private publishBusy(busy: boolean): void {
    for (const listener of this.busyListeners) {
      this.notifyBusyListener(listener, busy);
    }
  }

  private notifyBusyListener(listener: (busy: boolean) => void, busy: boolean): void {
    try {
      listener(busy);
    } catch {
      // Observers must not alter queue execution or settlement.
    }
  }
}

export function createDocumentSessionQueue(): DocumentSessionQueue {
  return new FifoDocumentSessionQueue();
}
