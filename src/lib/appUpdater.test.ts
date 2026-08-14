import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForAppUpdate,
  clearSkippedUpdateVersion,
  readSkippedUpdateVersion,
  skipUpdateVersion,
  installAppUpdate,
  type AppUpdate,
} from './appUpdater';

function update(version = '1.2.3'): AppUpdate {
  return {
    version,
    currentVersion: '1.0.0',
    body: 'Changes',
    downloadAndInstall: vi.fn<AppUpdate['downloadAndInstall']>(async () => undefined),
    close: vi.fn<AppUpdate['close']>(async () => undefined),
  };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('appUpdater', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
  });

  it('silently projects network and runtime failures to no update', async () => {
    await expect(checkForAppUpdate({ check: vi.fn<() => Promise<AppUpdate | null>>(async () => { throw new Error('offline'); }) }, storage))
      .resolves.toBeNull();
  });

  it('suppresses and closes only the explicitly skipped version', async () => {
    const available = update();
    skipUpdateVersion(available.version, storage);

    await expect(checkForAppUpdate({ check: vi.fn<() => Promise<AppUpdate | null>>(async () => available) }, storage)).resolves.toBeNull();
    expect(available.close).toHaveBeenCalledOnce();
    expect(readSkippedUpdateVersion(storage)).toBe('1.2.3');

    const newer = update('1.2.4');
    await expect(checkForAppUpdate({ check: vi.fn<() => Promise<AppUpdate | null>>(async () => newer) }, storage)).resolves.toBe(newer);
    clearSkippedUpdateVersion(storage);
    expect(readSkippedUpdateVersion(storage)).toBeNull();
  });

  it('ignores malformed persisted skip values', () => {
    storage.setItem('mmd.skippedUpdateVersion', ' not a version ');
    expect(readSkippedUpdateVersion(storage)).toBeNull();
  });

  it('relaunches only after a downloaded update installs successfully', async () => {
    const available = update();
    const relaunch = vi.fn<() => Promise<void>>(async () => undefined);
    await installAppUpdate(available, relaunch);
    expect(available.downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();

    const failed = update('1.2.4');
    vi.mocked(failed.downloadAndInstall).mockRejectedValueOnce(new Error('install failed'));
    await expect(installAppUpdate(failed, relaunch)).rejects.toThrow('install failed');
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
