import type { OpenIntentPreview } from './openIntent';
import { peekOpenIntent } from './tauriCommands';

export type PackagedHarness = 'lifecycle' | 'native-open';

export interface PackagedHarnessRunners {
  startApp: () => Promise<void>;
  startLifecycle: () => Promise<void>;
}

export function selectPackagedHarness(
  preview: OpenIntentPreview | null,
  nativeOpenEnabled: boolean,
): PackagedHarness {
  return nativeOpenEnabled
    && (preview?.source === 'startup_args' || preview?.source === 'opened_event')
    ? 'native-open'
    : 'lifecycle';
}

export async function runPackagedHarness(
  harness: PackagedHarness,
  runners: PackagedHarnessRunners,
): Promise<void> {
  if (harness === 'native-open') {
    await runners.startApp();
    return;
  }
  await runners.startLifecycle();
}

export async function startPackagedBootstrap(): Promise<void> {
  const preview = await peekOpenIntent();
  const harness = selectPackagedHarness(
    preview,
    import.meta.env.VITE_MMD_PACKAGED_OPEN_E2E === '1',
  );
  await runPackagedHarness(harness, {
    startApp: async () => {
      document.documentElement.dataset.mmdPackagedOpenE2e = 'active';
      await import('../main');
    },
    startLifecycle: async () => {
      const { startPackagedLifecycleE2e } = await import('./packagedLifecycleE2e');
      await startPackagedLifecycleE2e();
    },
  });
}
