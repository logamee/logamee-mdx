import { getPopoutOpenErrorMessage } from './popoutFeedback';
import type { PopoutCapablePane } from './paneLayout';

export type PaneWindowOperation =
  | 'lookup-window'
  | 'create-window'
  | 'focus-window'
  | 'listen-window-destroyed'
  | 'destroy-window';

export interface PaneWindowFailure {
  operation: PaneWindowOperation;
  pane: PopoutCapablePane;
  message: string;
}

export type PaneWindowOutcome<T> =
  | { status: 'succeeded'; value: T }
  | { status: 'failed'; failure: PaneWindowFailure };

export type PanePopoutOpenOutcome =
  | { status: 'created'; pane: PopoutCapablePane }
  | { status: 'existing'; pane: PopoutCapablePane }
  | { status: 'failed'; failure: PaneWindowFailure };

export interface PaneWindowHandle {
  focus(): Promise<void>;
  destroy(): Promise<void>;
}

export interface PaneWindowBackend {
  lookup(pane: PopoutCapablePane): Promise<PaneWindowHandle | null>;
  create(pane: PopoutCapablePane, instanceId?: string): Promise<PaneWindowHandle>;
  listenDestroyed(pane: PopoutCapablePane, listener: () => void): Promise<() => void>;
}

export interface TrackedPaneWindow {
  isOpen: boolean;
  unlisten: () => void;
}

export class PaneWindowAdapter {
  constructor(private readonly backend: PaneWindowBackend) {}

  async lookup(pane: PopoutCapablePane): Promise<PaneWindowOutcome<PaneWindowHandle | null>> {
    try {
      return { status: 'succeeded', value: await this.backend.lookup(pane) };
    } catch (error) {
      return { status: 'failed', failure: this.failure('lookup-window', pane, error) };
    }
  }

  async create(pane: PopoutCapablePane, instanceId?: string): Promise<PaneWindowOutcome<PaneWindowHandle>> {
    try {
      const handle = instanceId === undefined
        ? await this.backend.create(pane)
        : await this.backend.create(pane, instanceId);
      return { status: 'succeeded', value: handle };
    } catch (error) {
      return { status: 'failed', failure: this.failure('create-window', pane, error) };
    }
  }

  async focus(pane: PopoutCapablePane, handle: PaneWindowHandle): Promise<PaneWindowOutcome<void>> {
    try {
      await handle.focus();
      return { status: 'succeeded', value: undefined };
    } catch (error) {
      return { status: 'failed', failure: this.failure('focus-window', pane, error) };
    }
  }

  async listenDestroyed(
    pane: PopoutCapablePane,
    listener: () => void,
  ): Promise<PaneWindowOutcome<() => void>> {
    try {
      return { status: 'succeeded', value: await this.backend.listenDestroyed(pane, listener) };
    } catch (error) {
      return { status: 'failed', failure: this.failure('listen-window-destroyed', pane, error) };
    }
  }

  async destroy(pane: PopoutCapablePane, handle: PaneWindowHandle): Promise<PaneWindowOutcome<void>> {
    try {
      await handle.destroy();
      return { status: 'succeeded', value: undefined };
    } catch (error) {
      return { status: 'failed', failure: this.failure('destroy-window', pane, error) };
    }
  }

  private failure(operation: PaneWindowOperation, pane: PopoutCapablePane, error: unknown): PaneWindowFailure {
    return { operation, pane, message: getPopoutOpenErrorMessage(pane, error) };
  }
}

export class PanePopoutController {
  private readonly openOperations = new Map<PopoutCapablePane, Promise<PanePopoutOpenOutcome>>();

  constructor(private readonly windows: PaneWindowAdapter) {}

  open(
    pane: PopoutCapablePane,
    announceCurrentState: () => Promise<void>,
    instanceId?: string,
  ): Promise<PanePopoutOpenOutcome> {
    const inFlight = this.openOperations.get(pane);
    if (inFlight) return inFlight;

    const operation = this.openOnce(pane, announceCurrentState, instanceId).finally(() => {
      if (this.openOperations.get(pane) === operation) this.openOperations.delete(pane);
    });
    this.openOperations.set(pane, operation);
    return operation;
  }

  private async openOnce(
    pane: PopoutCapablePane,
    announceCurrentState: () => Promise<void>,
    instanceId?: string,
  ): Promise<PanePopoutOpenOutcome> {
    const lookup = await this.windows.lookup(pane);
    if (lookup.status === 'failed') return lookup;

    if (lookup.value) {
      await this.windows.focus(pane, lookup.value);
      await announceCurrentState();
      return { status: 'existing', pane };
    }

    const create = await this.windows.create(pane, instanceId);
    if (create.status === 'failed') return create;
    await announceCurrentState();
    return { status: 'created', pane };
  }

  async track(
    pane: PopoutCapablePane,
    onDestroyed: () => void,
  ): Promise<PaneWindowOutcome<TrackedPaneWindow>> {
    let destroyed = false;
    const listener = await this.windows.listenDestroyed(pane, () => {
      destroyed = true;
      onDestroyed();
    });
    if (listener.status === 'failed') return listener;
    const lookup = await this.windows.lookup(pane);
    if (lookup.status === 'failed') {
      listener.value();
      return lookup;
    }
    return {
      status: 'succeeded',
      value: { isOpen: !destroyed && lookup.value !== null, unlisten: listener.value },
    };
  }

  closeAll(panes: readonly PopoutCapablePane[]): Promise<Array<PaneWindowOutcome<void>>> {
    return Promise.all(panes.map((pane) => this.close(pane)));
  }

  private async close(pane: PopoutCapablePane): Promise<PaneWindowOutcome<void>> {
    const lookup = await this.windows.lookup(pane);
    if (lookup.status === 'failed') return lookup;
    if (!lookup.value) return { status: 'succeeded', value: undefined };
    return this.windows.destroy(pane, lookup.value);
  }
}
