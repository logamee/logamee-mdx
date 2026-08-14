import { useCallback, useEffect, useRef, useState } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import {
  checkForAppUpdate,
  installAppUpdate,
  skipUpdateVersion,
  type AppUpdate,
} from '../lib/appUpdater';

export function useAppUpdater(enabled: boolean) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const checked = useRef(false);

  useEffect(() => {
    if (!enabled || checked.current) return;
    checked.current = true;
    void checkForAppUpdate().then(setUpdate);
  }, [enabled]);

  const later = useCallback(() => setUpdate(null), []);
  const skip = useCallback(() => {
    if (update) skipUpdateVersion(update.version);
    setUpdate(null);
  }, [update]);
  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    try {
      await installAppUpdate(update, relaunch);
    } finally {
      setInstalling(false);
    }
  }, [update]);

  useEffect(() => () => {
    if (update) void update.close();
  }, [update]);

  return { update, installing, install, later, skip };
}
