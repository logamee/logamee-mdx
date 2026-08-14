import { describe, expect, it, vi } from 'vitest';
import type { OpenIntentPreview } from './openIntent';
import { runPackagedHarness, selectPackagedHarness } from './packagedBootstrap';

function preview(source: OpenIntentPreview['source']): OpenIntentPreview {
  return {
    id: 'open-intent-1',
    source,
    displayPath: source === 'session_restore' ? 'Restore previous workspace' : '/workspace/a.md',
    targetKind: source === 'session_restore' ? 'session_restore' : 'unknown',
  };
}

describe('packaged bootstrap dispatch', () => {
  it('keeps a startup-target package alive for native open evidence', () => {
    expect(selectPackagedHarness(preview('startup_args'), true)).toBe('native-open');
  });

  it('routes a cold macOS opened event to native open evidence', () => {
    expect(selectPackagedHarness(preview('opened_event'), true)).toBe('native-open');
  });

  it('preserves the lifecycle harness for targetless launches and ordinary builds', () => {
    expect(selectPackagedHarness(preview('session_restore'), true)).toBe('lifecycle');
    expect(selectPackagedHarness(preview('startup_args'), false)).toBe('lifecycle');
    expect(selectPackagedHarness(null, true)).toBe('lifecycle');
  });

  it('runs the real application bootstrap for native open evidence', async () => {
    const startApp = vi.fn<() => Promise<void>>().mockResolvedValue();
    const startLifecycle = vi.fn<() => Promise<void>>().mockResolvedValue();

    await runPackagedHarness('native-open', { startApp, startLifecycle });

    expect(startApp).toHaveBeenCalledOnce();
    expect(startLifecycle).not.toHaveBeenCalled();
  });

  it('preserves the lifecycle runner for lifecycle evidence', async () => {
    const startApp = vi.fn<() => Promise<void>>().mockResolvedValue();
    const startLifecycle = vi.fn<() => Promise<void>>().mockResolvedValue();

    await runPackagedHarness('lifecycle', { startApp, startLifecycle });

    expect(startLifecycle).toHaveBeenCalledOnce();
    expect(startApp).not.toHaveBeenCalled();
  });
});
