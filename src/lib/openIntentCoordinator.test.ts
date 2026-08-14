import { describe, expect, it, vi } from 'vitest';
import {
  OpenIntentCoordinator,
  type AppOpenIntent,
  type OpenIntentSettlement,
} from './openIntentCoordinator';
import { adaptBackendOpenIntent, createLocalOpenIntent } from './openIntent';

function intent(id: string, displayPath = `/workspace/${id}.md`): AppOpenIntent {
  return adaptBackendOpenIntent({ id, targetKind: 'unknown', displayPath, source: 'startup_args' });
}

function localIntent(id: string, path = `/workspace/${id}.md`): AppOpenIntent {
  return createLocalOpenIntent(id, 'sidebar', path, { kind: 'workspace_file', path });
}

describe('OpenIntentCoordinator', () => {
  it('activates distinct requests in FIFO order', () => {
    const activated: string[] = [];
    const coordinator = new OpenIntentCoordinator({
      onActivate: (next) => activated.push(next.id),
      onSettle: vi.fn<(intent: AppOpenIntent, settlement: OpenIntentSettlement) => void>(),
    });

    coordinator.enqueue(intent('one'));
    coordinator.enqueue(intent('two'));
    coordinator.enqueue(intent('three'));

    expect(activated).toEqual(['one']);
    expect(coordinator.pending.map((next) => next.id)).toEqual(['two', 'three']);
    expect(coordinator.acceptActive('one')).toBe(true);
    expect(coordinator.acceptActive('two')).toBe(true);
    expect(coordinator.acceptActive('three')).toBe(true);
    expect(activated).toEqual(['one', 'two', 'three']);
    expect(coordinator.active).toBeNull();
  });

  it('coalesces duplicate IDs and targets without focusing the same request twice', () => {
    const onActivate = vi.fn<(next: AppOpenIntent) => void>();
    const coordinator = new OpenIntentCoordinator({
      onActivate,
      onSettle: vi.fn<(settled: AppOpenIntent, settlement: OpenIntentSettlement) => void>(),
    });

    expect(coordinator.enqueue(intent('one'))).toBe(true);
    expect(coordinator.enqueue(intent('one', '/other.md'))).toBe(false);
    expect(coordinator.enqueue(intent('two', '/workspace/one.md'))).toBe(false);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenLastCalledWith(intent('one'));
    expect(coordinator.pending).toEqual([]);
  });

  it('rejects a late duplicate ID after settlement without suppressing a new request', () => {
    const onActivate = vi.fn<(next: AppOpenIntent) => void>();
    const coordinator = new OpenIntentCoordinator({
      onActivate,
      onSettle: vi.fn<(settled: AppOpenIntent, settlement: OpenIntentSettlement) => void>(),
    });
    const first = intent('one');

    expect(coordinator.enqueue(first)).toBe(true);
    expect(coordinator.acceptActive(first.id)).toBe(true);
    expect(coordinator.enqueue(first)).toBe(false);
    expect(coordinator.enqueue(intent('two', first.displayPath))).toBe(true);

    expect(onActivate.mock.calls.map(([activated]) => activated.id)).toEqual(['one', 'two']);
  });

  it('rejects canonical backend replays beyond 64 settlements while accepting a newer same-target ID', () => {
    const coordinator = new OpenIntentCoordinator({
      onActivate: vi.fn<(next: AppOpenIntent) => void>(),
      onSettle: vi.fn<(settled: AppOpenIntent, settlement: OpenIntentSettlement) => void>(),
    });
    let lastPath = '';

    for (let index = 1; index <= 70; index += 1) {
      const id = `open-intent-${index * 2}`;
      lastPath = `/workspace/backend-${index}.md`;
      expect(coordinator.enqueue(intent(id, lastPath))).toBe(true);
      expect(coordinator.acceptActive(id)).toBe(true);
    }

    expect(coordinator.enqueue(intent('open-intent-1', '/workspace/stale-backend.md'))).toBe(false);
    expect(coordinator.enqueue(intent('open-intent-141', lastPath))).toBe(true);
  });

  it('rejects canonical local replays beyond 64 settlements while accepting a newer same-target ID', () => {
    const coordinator = new OpenIntentCoordinator({
      onActivate: vi.fn<(next: AppOpenIntent) => void>(),
      onSettle: vi.fn<(settled: AppOpenIntent, settlement: OpenIntentSettlement) => void>(),
    });
    let lastPath = '';

    for (let index = 1; index <= 70; index += 1) {
      const id = `local-open-intent-${index * 2}`;
      lastPath = `/workspace/local-${index}.md`;
      expect(coordinator.enqueue(localIntent(id, lastPath))).toBe(true);
      expect(coordinator.acceptActive(id)).toBe(true);
    }

    expect(coordinator.enqueue(localIntent('local-open-intent-1', '/workspace/stale-local.md'))).toBe(false);
    expect(coordinator.enqueue(localIntent('local-open-intent-141', lastPath))).toBe(true);
  });

  it('coalesces exact duplicate local actions while preserving distinct targets', () => {
    const onActivate = vi.fn<(next: AppOpenIntent) => void>();
    const coordinator = new OpenIntentCoordinator({
      onActivate,
      onSettle: vi.fn<(settled: AppOpenIntent, settlement: OpenIntentSettlement) => void>(),
    });
    const first = createLocalOpenIntent(
      'local-open-intent-1',
      'sidebar',
      '/workspace/one.md',
      { kind: 'workspace_file', path: '/workspace/one.md' },
    );
    const duplicate = createLocalOpenIntent(
      'local-open-intent-2',
      'sidebar',
      '/workspace/one.md',
      { kind: 'workspace_file', path: '/workspace/one.md' },
    );
    const distinct = createLocalOpenIntent(
      'local-open-intent-3',
      'sidebar',
      '/workspace/two.md',
      { kind: 'workspace_file', path: '/workspace/two.md' },
    );

    expect(coordinator.enqueue(first)).toBe(true);
    expect(coordinator.enqueue(duplicate)).toBe(false);
    expect(coordinator.enqueue(distinct)).toBe(true);

    expect(onActivate).toHaveBeenCalledOnce();
    expect(coordinator.pending).toEqual([distinct]);
  });

  it('waits for a modal to close before activating queued work', () => {
    const activated: string[] = [];
    const coordinator = new OpenIntentCoordinator({
      onActivate: (next) => activated.push(next.id),
      onSettle: vi.fn<(intent: AppOpenIntent, settlement: OpenIntentSettlement) => void>(),
    });

    coordinator.setModalActive(true);
    coordinator.enqueue(intent('one'));
    coordinator.enqueue(intent('two'));

    expect(coordinator.active).toBeNull();
    expect(activated).toEqual([]);
    coordinator.setModalActive(false);
    expect(activated).toEqual(['one']);

    coordinator.setModalActive(true);
    coordinator.acceptActive('one');
    expect(activated).toEqual(['one']);
    coordinator.setModalActive(false);
    expect(activated).toEqual(['one', 'two']);
  });

  it('drains after cancellation and failure, and settles each active request once', () => {
    const activated: string[] = [];
    const onSettle = vi.fn<(settled: AppOpenIntent, settlement: OpenIntentSettlement) => void>();
    const coordinator = new OpenIntentCoordinator({
      onActivate: (next) => activated.push(next.id),
      onSettle,
    });
    const error = new Error('authorization failed');

    coordinator.enqueue(intent('one'));
    coordinator.enqueue(intent('two'));
    coordinator.enqueue(intent('three'));

    expect(coordinator.cancelActive('one')).toBe(true);
    expect(coordinator.failActive('two', error)).toBe(true);
    expect(coordinator.acceptActive('two')).toBe(false);
    expect(coordinator.acceptActive('three')).toBe(true);

    expect(activated).toEqual(['one', 'two', 'three']);
    expect(onSettle).toHaveBeenCalledTimes(3);
    expect(onSettle).toHaveBeenNthCalledWith(1, intent('one'), { kind: 'cancelled' });
    expect(onSettle).toHaveBeenNthCalledWith(2, intent('two'), { kind: 'failed', error });
    expect(onSettle).toHaveBeenNthCalledWith(3, intent('three'), { kind: 'accepted' });
  });

  it('does not activate a successor until the active settlement callback completes', () => {
    const events: string[] = [];
    let coordinator: OpenIntentCoordinator;
    coordinator = new OpenIntentCoordinator({
      onActivate: (next) => events.push(`activate:${next.id}`),
      onSettle: (settled) => {
        events.push(`settle:${settled.id}`);
        coordinator.setModalActive(true);
      },
    });

    coordinator.enqueue(intent('one'));
    coordinator.enqueue(intent('two'));
    coordinator.acceptActive('one');

    expect(events).toEqual(['activate:one', 'settle:one']);
    expect(coordinator.active).toBeNull();
    coordinator.setModalActive(false);
    expect(events).toEqual(['activate:one', 'settle:one', 'activate:two']);
  });

  it('serializes backend, menu, sidebar, search, crash recovery, and session intents in one FIFO', () => {
    const activated: string[] = [];
    const coordinator = new OpenIntentCoordinator({
      onActivate: (next) => activated.push(`${next.origin}:${next.source}`),
      onSettle: vi.fn<(intent: AppOpenIntent, settlement: OpenIntentSettlement) => void>(),
    });
    const intents: AppOpenIntent[] = [
      intent('native'),
      createLocalOpenIntent('local-1', 'native_menu', 'Open file', { kind: 'open_file' }),
      createLocalOpenIntent('local-2', 'native_menu', 'Open directory', { kind: 'open_directory' }),
      createLocalOpenIntent('local-3', 'native_menu', 'Recent', { kind: 'open_recent', entryId: 'recent-1' }),
      createLocalOpenIntent('local-4', 'native_menu', 'New document', { kind: 'new_document' }),
      createLocalOpenIntent('local-5', 'sidebar', '/workspace/sidebar.md', { kind: 'workspace_file', path: '/workspace/sidebar.md' }),
      createLocalOpenIntent('local-6', 'workspace_search', 'notes/result.md', {
        kind: 'workspace_search_result',
        selection: { workspaceToken: 'workspace-1', workspaceRoot: '/workspace', indexGeneration: 2, relativePath: 'notes/result.md' },
      }),
      createLocalOpenIntent('local-7', 'crash_recovery', 'Recovered draft', {
        kind: 'crash_draft',
        draft: {
          documentId: 'document-1', entryToken: 'entry-token-1234567890', pathHint: '/workspace/recovered.md',
          baseVersionToken: null, content: '# recovered', draftRevision: 1, fileKind: 'markdown', updatedAtUnixMs: 1,
        },
      }),
      adaptBackendOpenIntent({ id: 'open-intent-9', source: 'session_restore', displayPath: 'Restore previous workspace', targetKind: 'session_restore' }),
    ];

    intents.forEach((next) => coordinator.enqueue(next));
    while (coordinator.active) coordinator.acceptActive(coordinator.active.id);

    expect(activated).toEqual([
      'backend:startup_args',
      'local:native_menu',
      'local:native_menu',
      'local:native_menu',
      'local:native_menu',
      'local:sidebar',
      'local:workspace_search',
      'local:crash_recovery',
      'backend:session_restore',
    ]);
  });
});
