import { invoke } from '@tauri-apps/api/core';

// 打包打开 E2E 配置与事件命令。

export interface PackagedOpenE2eConfig {
  profile: 'apply-reobserve' | 'restore-cancel';
  unicodeRenameReady: boolean;
  paths: {
    primaryFile: string;
    unicodeFile: string;
    renamedUnicodeFile: string;
    associationFile: string;
    workspaceDirectory: string;
    staleFile: string;
  };
}

export type PackagedOpenAppEventType =
  | 'app_activated'
  | 'dirty_modal_opened'
  | 'dirty_decision'
  | 'app_applied'
  | 'app_settled';

export interface PackagedOpenAppEvent {
  type: PackagedOpenAppEventType;
  intentId: string;
  step: string;
  fields: Record<string, unknown>;
}

// 顶层字段校验：恰好三键、受控 profile、布尔就绪位与对象 paths。
function packagedOpenProfileInvalid(record: Record<string, unknown>): boolean {
  return Object.keys(record).length !== 3
    || (record.profile !== 'apply-reobserve' && record.profile !== 'restore-cancel')
    || typeof record.unicodeRenameReady !== 'boolean'
    || typeof record.paths !== 'object'
    || record.paths === null
    || Array.isArray(record.paths);
}

function packagedOpenPathsInvalid(paths: Record<string, unknown>, pathKeys: readonly string[]): boolean {
  return Object.keys(paths).length !== pathKeys.length
    || pathKeys.some((key) => typeof paths[key] !== 'string' || paths[key].trim().length === 0);
}

function decodePackagedOpenE2eConfig(value: unknown): PackagedOpenE2eConfig | null {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid packaged open E2E config');
  }
  const record = value as Record<string, unknown>;
  if (packagedOpenProfileInvalid(record)) {
    throw new Error('Invalid packaged open E2E config');
  }
  const paths = record.paths as Record<string, unknown>;
  const pathKeys = [
    'primaryFile',
    'unicodeFile',
    'renamedUnicodeFile',
    'associationFile',
    'workspaceDirectory',
    'staleFile',
  ] as const;
  if (packagedOpenPathsInvalid(paths, pathKeys)) {
    throw new Error('Invalid packaged open E2E config');
  }
  return {
    profile: record.profile as PackagedOpenE2eConfig['profile'],
    unicodeRenameReady: record.unicodeRenameReady as boolean,
    paths: Object.fromEntries(pathKeys.map((key) => [key, paths[key]])) as PackagedOpenE2eConfig['paths'],
  };
}

export async function getPackagedOpenE2eConfig(): Promise<PackagedOpenE2eConfig | null> {
  return decodePackagedOpenE2eConfig(await invoke<unknown>('get_packaged_open_e2e_config'));
}

export function recordPackagedOpenAppEvent(event: PackagedOpenAppEvent): Promise<void> {
  return invoke<void>('record_packaged_open_app_event', { event });
}
