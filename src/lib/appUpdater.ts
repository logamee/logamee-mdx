import { check, type Update } from '@tauri-apps/plugin-updater';

const SKIPPED_UPDATE_VERSION_KEY = 'mmd.skippedUpdateVersion';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface AppUpdate {
  version: string;
  currentVersion: string;
  body?: string;
  downloadAndInstall: Update['downloadAndInstall'];
  close: Update['close'];
}

export async function installAppUpdate(
  update: AppUpdate,
  relaunchApp: () => Promise<void>,
): Promise<void> {
  await update.downloadAndInstall();
  await relaunchApp();
}

interface UpdaterApi {
  check(): Promise<AppUpdate | null>;
}

const defaultApi: UpdaterApi = { check };

export function readSkippedUpdateVersion(storage: Storage = localStorage): string | null {
  const value = storage.getItem(SKIPPED_UPDATE_VERSION_KEY);
  return value && VERSION_PATTERN.test(value) ? value : null;
}

export function skipUpdateVersion(version: string, storage: Storage = localStorage): void {
  if (VERSION_PATTERN.test(version)) storage.setItem(SKIPPED_UPDATE_VERSION_KEY, version);
}

export function clearSkippedUpdateVersion(storage: Storage = localStorage): void {
  storage.removeItem(SKIPPED_UPDATE_VERSION_KEY);
}

export async function checkForAppUpdate(
  api: UpdaterApi = defaultApi,
  storage: Storage = localStorage,
): Promise<AppUpdate | null> {
  try {
    const update = await api.check();
    if (!update) return null;
    if (readSkippedUpdateVersion(storage) === update.version) {
      await update.close();
      return null;
    }
    return update;
  } catch {
    return null;
  }
}
