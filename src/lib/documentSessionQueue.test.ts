import { describe, expect, it, vi } from 'vitest';
import { isDocumentDirty } from './documentSession';
import { createDocumentSessionQueue } from './documentSessionQueue';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('document session queue', () => {
  it('runs and applies operations in enqueue order', async () => {
    const queue = createDocumentSessionQueue();
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const firstApplyStarted = createDeferred<void>();
    const finishFirstApply = createDeferred<void>();
    const events: string[] = [];

    const firstResult = queue.enqueue({
      run: async () => {
        events.push('run:first');
        return first.promise;
      },
      apply: async (value) => {
        events.push(`apply:${value}`);
        firstApplyStarted.resolve();
        await finishFirstApply.promise;
        events.push(`applied:${value}`);
      },
    });
    const secondResult = queue.enqueue({
      run: async () => {
        events.push('run:second');
        return second.promise;
      },
      apply: (value) => {
        events.push(`apply:${value}`);
      },
    });

    await Promise.resolve();
    expect(events).toEqual(['run:first']);

    first.resolve('first');
    await firstApplyStarted.promise;
    expect(events).toEqual(['run:first', 'apply:first']);

    finishFirstApply.resolve();
    await expect(firstResult).resolves.toEqual({ status: 'applied', value: 'first' });
    expect(events).toEqual(['run:first', 'apply:first', 'applied:first', 'run:second']);

    second.resolve('second');
    await expect(secondResult).resolves.toEqual({ status: 'applied', value: 'second' });
    expect(events).toEqual([
      'run:first',
      'apply:first',
      'applied:first',
      'run:second',
      'apply:second',
    ]);
  });

  it('checks caller-owned generation and workspace identity before applying', async () => {
    const queue = createDocumentSessionQueue();
    const response = createDeferred<string>();
    let generation = 4;
    let workspaceToken = 'workspace-a';
    const requestedGeneration = generation;
    const requestedWorkspaceToken = workspaceToken;
    const apply = vi.fn<(value: string) => void>();

    const result = queue.enqueue({
      run: () => response.promise,
      isCurrent: () => generation === requestedGeneration
        && workspaceToken === requestedWorkspaceToken,
      apply,
    });

    generation += 1;
    workspaceToken = 'workspace-b';
    response.resolve('stale response');

    await expect(result).resolves.toEqual({
      status: 'discarded',
      value: 'stale response',
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('consumes_mutation_outcomes_even_when_generation_discards_state_application', async () => {
    const queue = createDocumentSessionQueue();
    const response = createDeferred<{ status: string; recoveryMessage: string }>();
    let generation = 2;
    const requestedGeneration = generation;
    const consumed: string[] = [];
    const apply = vi.fn<(value: { status: string; recoveryMessage: string }) => void>();

    const result = queue.enqueue({
      run: () => response.promise,
      consume: (outcome) => {
        consumed.push(outcome.recoveryMessage);
      },
      isCurrent: () => generation === requestedGeneration,
      apply,
    });

    generation += 1;
    response.resolve({ status: 'indeterminate', recoveryMessage: 'Inspect the file before retrying.' });

    await expect(result).resolves.toEqual({
      status: 'discarded',
      value: { status: 'indeterminate', recoveryMessage: 'Inspect the file before retrying.' },
    });
    expect(consumed).toEqual(['Inspect the file before retrying.']);
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not let an old open response replace a newer document intent', async () => {
    const queue = createDocumentSessionQueue();
    const response = createDeferred<string>();
    let documentGeneration = 0;
    let activeDocument = 'untitled';
    const requestedGeneration = ++documentGeneration;

    const openResult = queue.enqueue({
      run: () => response.promise,
      isCurrent: () => documentGeneration === requestedGeneration,
      apply: (document) => {
        activeDocument = document;
      },
    });

    documentGeneration += 1;
    activeDocument = 'new document';
    response.resolve('old opened document');

    await expect(openResult).resolves.toEqual({
      status: 'discarded',
      value: 'old opened document',
    });
    expect(activeDocument).toBe('new document');
  });

  it('does not apply an old snapshot after a workspace switch intent', async () => {
    const queue = createDocumentSessionQueue();
    const response = createDeferred<string>();
    let workspaceGeneration = 0;
    let workspaceToken = 'workspace-a';
    let visibleSnapshot = 'snapshot-a';
    const requestedGeneration = workspaceGeneration;
    const requestedWorkspaceToken = workspaceToken;

    const refreshResult = queue.enqueue({
      run: () => response.promise,
      isCurrent: () => workspaceGeneration === requestedGeneration
        && workspaceToken === requestedWorkspaceToken,
      apply: (snapshot) => {
        visibleSnapshot = snapshot;
      },
    });

    workspaceGeneration += 1;
    workspaceToken = 'workspace-b';
    visibleSnapshot = 'snapshot-b';
    response.resolve('late snapshot-a');

    await expect(refreshResult).resolves.toEqual({
      status: 'discarded',
      value: 'late snapshot-a',
    });
    expect(visibleSnapshot).toBe('snapshot-b');
  });

  it('marks only the content captured by the save operation as saved', async () => {
    const queue = createDocumentSessionQueue();
    const writeCompleted = createDeferred<void>();
    let content = '# Version one';
    let lastSavedContent = '';
    const contentToSave = content;

    const saveResult = queue.enqueue({
      run: async () => {
        await writeCompleted.promise;
        return contentToSave;
      },
      apply: (savedContent) => {
        lastSavedContent = savedContent;
      },
    });

    content = '# Version two';
    writeCompleted.resolve();

    await expect(saveResult).resolves.toEqual({
      status: 'applied',
      value: '# Version one',
    });
    expect(content).toBe('# Version two');
    expect(lastSavedContent).toBe('# Version one');
  });

  it('keeps the previous saved snapshot when a save fails', async () => {
    const queue = createDocumentSessionQueue();
    const content = '# Unsaved content';
    let lastSavedContent = '# Saved content';

    const saveResult = queue.enqueue({
      run: async () => {
        throw new Error('write failed');
      },
      apply: (savedContent: string) => {
        lastSavedContent = savedContent;
      },
    });

    await expect(saveResult).rejects.toThrow('write failed');
    expect(content).toBe('# Unsaved content');
    expect(lastSavedContent).toBe('# Saved content');
    expect(isDocumentDirty({ activeFileKind: 'markdown', content, lastSavedContent })).toBe(true);
  });

  it('keeps busy true while an operation is running or queued', async () => {
    const queue = createDocumentSessionQueue();
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const busyStates: boolean[] = [];
    const unsubscribe = queue.subscribeBusy((busy) => busyStates.push(busy));

    const firstResult = queue.enqueue({ run: () => first.promise });
    const secondResult = queue.enqueue({ run: () => second.promise });

    expect(queue.busy).toBe(true);
    expect(busyStates).toEqual([false, true]);

    first.resolve();
    await firstResult;
    expect(queue.busy).toBe(true);
    expect(busyStates).toEqual([false, true]);

    second.resolve();
    await secondResult;
    expect(queue.busy).toBe(false);
    expect(busyStates).toEqual([false, true, false]);

    unsubscribe();
  });

  it('continues after run and apply errors', async () => {
    const queue = createDocumentSessionQueue();
    const events: string[] = [];

    const failedRun = queue.enqueue({
      run: async () => {
        events.push('run:failed');
        throw new Error('run failed');
      },
    });
    const failedApply = queue.enqueue({
      run: async () => {
        events.push('run:apply-failed');
        return 'apply-failed';
      },
      apply: () => {
        events.push('apply:failed');
        throw new Error('apply failed');
      },
    });
    const succeeded = queue.enqueue({
      run: async () => {
        events.push('run:succeeded');
        return 'succeeded';
      },
      apply: (value) => {
        events.push(`apply:${value}`);
      },
    });

    await expect(failedRun).rejects.toThrow('run failed');
    await expect(failedApply).rejects.toThrow('apply failed');
    await expect(succeeded).resolves.toEqual({ status: 'applied', value: 'succeeded' });
    expect(events).toEqual([
      'run:failed',
      'run:apply-failed',
      'apply:failed',
      'run:succeeded',
      'apply:succeeded',
    ]);
  });
});
