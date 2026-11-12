import { invoke } from '@tauri-apps/api/core';

export async function getStartupError(): Promise<string | null> {
  const value = await invoke<unknown>('get_startup_error');
  if (value === null || typeof value === 'string') return value;
  throw new Error('Invalid startup error response');
}
