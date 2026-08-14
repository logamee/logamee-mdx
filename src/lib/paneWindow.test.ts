import { describe, expect, it, vi } from 'vitest';
import {
  PanePopoutController,
  PaneWindowAdapter,
  type PaneWindowBackend,
  type PaneWindowHandle,
} from './paneWindow';

describe('pane window adapter', () => {
  it('pane_window_adapter_failure_returns_normalized_failure_evidence', async () => {
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>(),
      create: vi.fn<PaneWindowBackend['create']>().mockRejectedValue(new Error('webview failed')),
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>(),
    };
    const adapter = new PaneWindowAdapter(backend);

    const outcomePromise = adapter.create('preview');

    await expect(outcomePromise).resolves.toEqual({
      status: 'failed',
      failure: {
        operation: 'create-window',
        pane: 'preview',
        message: '无法打开 Live Preview 独立窗口：应用窗口通信暂时失败。请重试。',
      },
    });
    expect(backend.create).toHaveBeenCalledOnce();
    expect(backend.create).toHaveBeenCalledWith('preview');

    const outcome = await outcomePromise;
    expect(outcome.status === 'failed' ? outcome.failure.message : '').not.toContain('webview failed');
    expect(outcome.status === 'failed' ? outcome.failure.message : '').not.toContain('Error:');
  });

  it('pane_window_adapter_does_not_leak_localized_runtime_failure', async () => {
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>(),
      create: vi.fn<PaneWindowBackend['create']>().mockRejectedValue(
        new Error('Webview 窗口创建失败：/Users/private/path'),
      ),
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>(),
    };
    const adapter = new PaneWindowAdapter(backend);

    const outcome = await adapter.create('editor');

    expect(outcome).toEqual({
      status: 'failed',
      failure: {
        operation: 'create-window',
        pane: 'editor',
        message: '无法打开 Editor 独立窗口：应用窗口通信暂时失败。请重试。',
      },
    });
    expect(outcome.status === 'failed' ? outcome.failure.message : '').not.toContain('/Users/private/path');
    expect(outcome.status === 'failed' ? outcome.failure.message : '').not.toContain('窗口创建失败');
  });

  it('existing_popout_focus_path_does_not_create_window_or_second_replication_engine', async () => {
    const calls: string[] = [];
    const existingHandle: PaneWindowHandle = {
      focus: vi.fn<PaneWindowHandle['focus']>(async () => {
        calls.push('focus:editor');
      }),
      destroy: vi.fn<PaneWindowHandle['destroy']>(),
    };
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>(async (pane) => {
        calls.push(`lookup:${pane}`);
        return existingHandle;
      }),
      create: vi.fn<PaneWindowBackend['create']>(async (pane) => {
        calls.push(`create:${pane}`);
        return existingHandle;
      }),
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>(),
    };
    const announceCurrentState = vi.fn<() => Promise<void>>(async () => {
      calls.push('announce:editor');
    });
    const controller = new PanePopoutController(new PaneWindowAdapter(backend));

    const outcome = await controller.open('editor', announceCurrentState);

    expect(outcome).toEqual({ status: 'existing', pane: 'editor' });
    expect(calls).toEqual(['lookup:editor', 'focus:editor', 'announce:editor']);
    expect(backend.create).not.toHaveBeenCalled();
    expect(announceCurrentState).toHaveBeenCalledOnce();
    expect('createReplication' in controller).toBe(false);
    expect('startReplication' in controller).toBe(false);
  });

  it('repeated_focus_failure_remains_non_error_state', async () => {
    const calls: string[] = [];
    const existingHandle: PaneWindowHandle = {
      focus: vi.fn<PaneWindowHandle['focus']>(async () => {
        calls.push('focus:preview');
        throw new Error('focus failed');
      }),
      destroy: vi.fn<PaneWindowHandle['destroy']>(),
    };
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>(async (pane) => {
        calls.push(`lookup:${pane}`);
        return existingHandle;
      }),
      create: vi.fn<PaneWindowBackend['create']>(async (pane) => {
        calls.push(`create:${pane}`);
        return existingHandle;
      }),
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>(),
    };
    const announceCurrentState = vi.fn<() => Promise<void>>(async () => {
      calls.push('announce:preview');
    });
    const controller = new PanePopoutController(new PaneWindowAdapter(backend));

    const firstOutcome = await controller.open('preview', announceCurrentState);
    const secondOutcome = await controller.open('preview', announceCurrentState);

    expect(firstOutcome).toEqual({ status: 'existing', pane: 'preview' });
    expect(secondOutcome).toEqual({ status: 'existing', pane: 'preview' });
    expect(calls).toEqual([
      'lookup:preview',
      'focus:preview',
      'announce:preview',
      'lookup:preview',
      'focus:preview',
      'announce:preview',
    ]);
    expect(existingHandle.focus).toHaveBeenCalledTimes(2);
    expect(announceCurrentState).toHaveBeenCalledTimes(2);
    expect(backend.create).not.toHaveBeenCalled();
  });

  it('deduplicates_concurrent_open_calls_for_the_same_pane', async () => {
    let resolveCreate!: (handle: PaneWindowHandle) => void;
    const handle: PaneWindowHandle = {
      focus: vi.fn<PaneWindowHandle['focus']>(),
      destroy: vi.fn<PaneWindowHandle['destroy']>(),
    };
    const create = vi.fn<PaneWindowBackend['create']>(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>().mockResolvedValue(null),
      create,
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>(),
    };
    const announceCurrentState = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = new PanePopoutController(new PaneWindowAdapter(backend));

    const first = controller.open('editor', announceCurrentState);
    const second = controller.open('editor', announceCurrentState);
    await Promise.resolve();
    await Promise.resolve();

    expect(backend.lookup).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();

    resolveCreate(handle);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'created', pane: 'editor' },
      { status: 'created', pane: 'editor' },
    ]);
    expect(announceCurrentState).toHaveBeenCalledOnce();
  });

  it('forwards_an_editor_instance_id_when_creating_a_popout', async () => {
    const handle: PaneWindowHandle = {
      focus: vi.fn<PaneWindowHandle['focus']>(),
      destroy: vi.fn<PaneWindowHandle['destroy']>(),
    };
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>().mockResolvedValue(null),
      create: vi.fn<PaneWindowBackend['create']>().mockResolvedValue(handle),
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>(),
    };
    const controller = new PanePopoutController(new PaneWindowAdapter(backend));

    await expect(controller.open('editor', async () => undefined, 'editor:instance-1')).resolves.toEqual({
      status: 'created',
      pane: 'editor',
    });

    expect(backend.create).toHaveBeenCalledWith('editor', 'editor:instance-1');
  });

  it('tracks_existing_window_and_returns_destroyed_listener_cleanup', async () => {
    const existingHandle: PaneWindowHandle = {
      focus: vi.fn<PaneWindowHandle['focus']>(),
      destroy: vi.fn<PaneWindowHandle['destroy']>(),
    };
    const unlisten = vi.fn<() => void>();
    const listenDestroyed = vi.fn<PaneWindowBackend['listenDestroyed']>(async (_pane, _listener) => {
      return unlisten;
    });
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>().mockResolvedValue(existingHandle),
      create: vi.fn<PaneWindowBackend['create']>(),
      listenDestroyed,
    };
    const onDestroyed = vi.fn<() => void>();
    const controller = new PanePopoutController(new PaneWindowAdapter(backend));

    const outcome = await controller.track('editor', onDestroyed);

    expect(outcome).toEqual({ status: 'succeeded', value: { isOpen: true, unlisten } });
    expect(backend.listenDestroyed).toHaveBeenCalledWith('editor', expect.any(Function));
    expect(backend.lookup).toHaveBeenCalledWith('editor');
    expect(listenDestroyed.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(backend.lookup).mock.invocationCallOrder[0],
    );
    listenDestroyed.mock.calls[0][1]();
    expect(onDestroyed).toHaveBeenCalledOnce();
    if (outcome.status === 'succeeded') outcome.value.unlisten();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('reports_closed_when_destroyed_fires_between_listener_registration_and_lookup', async () => {
    const handle: PaneWindowHandle = {
      focus: vi.fn<PaneWindowHandle['focus']>(),
      destroy: vi.fn<PaneWindowHandle['destroy']>(),
    };
    let destroyedListener: (() => void) | null = null;
    const unlisten = vi.fn<() => void>();
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>(async () => {
        destroyedListener?.();
        return handle;
      }),
      create: vi.fn<PaneWindowBackend['create']>(),
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>(async (_pane, listener) => {
        destroyedListener = listener;
        return unlisten;
      }),
    };
    const onDestroyed = vi.fn<() => void>();
    const controller = new PanePopoutController(new PaneWindowAdapter(backend));

    const outcome = await controller.track('preview', onDestroyed);

    expect(outcome).toEqual({ status: 'succeeded', value: { isOpen: false, unlisten } });
    expect(onDestroyed).toHaveBeenCalledOnce();
  });

  it('cleans_up_destroyed_listener_when_lookup_fails', async () => {
    const unlisten = vi.fn<() => void>();
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>().mockRejectedValue(new Error('lookup failed')),
      create: vi.fn<PaneWindowBackend['create']>(),
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>().mockResolvedValue(unlisten),
    };
    const controller = new PanePopoutController(new PaneWindowAdapter(backend));

    const outcome = await controller.track('editor', () => undefined);

    expect(outcome.status).toBe('failed');
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('close_all_attempts_every_window_when_one_destroy_fails', async () => {
    const editorHandle: PaneWindowHandle = {
      focus: vi.fn<PaneWindowHandle['focus']>(),
      destroy: vi.fn<PaneWindowHandle['destroy']>().mockRejectedValue(new Error('destroy failed')),
    };
    const previewHandle: PaneWindowHandle = {
      focus: vi.fn<PaneWindowHandle['focus']>(),
      destroy: vi.fn<PaneWindowHandle['destroy']>().mockResolvedValue(undefined),
    };
    const backend: PaneWindowBackend = {
      lookup: vi.fn<PaneWindowBackend['lookup']>(async (pane) => (
        pane === 'editor' ? editorHandle : previewHandle
      )),
      create: vi.fn<PaneWindowBackend['create']>(),
      listenDestroyed: vi.fn<PaneWindowBackend['listenDestroyed']>(),
    };
    const controller = new PanePopoutController(new PaneWindowAdapter(backend));

    const outcomes = await controller.closeAll(['editor', 'preview']);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'succeeded']);
    expect(editorHandle.destroy).toHaveBeenCalledOnce();
    expect(previewHandle.destroy).toHaveBeenCalledOnce();
  });
});
