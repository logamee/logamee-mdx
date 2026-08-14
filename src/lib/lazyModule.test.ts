import { describe, expect, it, vi } from 'vitest';
import { loadLazyModuleWithRetry } from './lazyModule';

describe('loadLazyModuleWithRetry', () => {
  it('does not repeat a successful module load', async () => {
    const loadedModule = { default: () => null };
    const load = vi.fn<() => Promise<typeof loadedModule>>().mockResolvedValue(loadedModule);

    await expect(loadLazyModuleWithRetry(load)).resolves.toBe(loadedModule);
    expect(load).toHaveBeenCalledOnce();
  });

  it('retries one transient module load failure before rejecting to React.lazy', async () => {
    const loadedModule = { default: () => null };
    const load = vi.fn<() => Promise<typeof loadedModule>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce(loadedModule);

    await expect(loadLazyModuleWithRetry(load)).resolves.toBe(loadedModule);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops after the retry and exposes the terminal load failure', async () => {
    const terminalError = new Error('Module asset is unavailable');
    const load = vi.fn<() => Promise<never>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockRejectedValueOnce(terminalError);

    await expect(loadLazyModuleWithRetry(load)).rejects.toBe(terminalError);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
