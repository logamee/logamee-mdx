import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStartupError } from './startup';

const invokeMock = vi.hoisted(() => vi.fn<(command: string) => Promise<unknown>>());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

describe('startup error command', () => {
  beforeEach(() => invokeMock.mockReset());

  it.each([null, 'Recent files unavailable at startup', ''])('decodes %j without consuming it', async (value) => {
    invokeMock.mockResolvedValue(value);
    await expect(getStartupError()).resolves.toBe(value);
    await expect(getStartupError()).resolves.toBe(value);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith('get_startup_error');
  });

  it.each([undefined, false, 7, [], {}, { error: 'Recent files unavailable at startup' }])(
    'rejects invalid startup payload %j', async (value) => {
      invokeMock.mockResolvedValue(value);
      await expect(getStartupError()).rejects.toThrow('Invalid startup error response');
    },
  );
});
