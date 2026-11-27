import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEMP_ENVIRONMENT_VARIABLES = ['TMPDIR', 'TMP', 'TEMP'];

export function usePrivateScratchTemp(prefix) {
  const scratchTemp = mkdtempSync(path.join(os.tmpdir(), prefix));
  const previousValues = TEMP_ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]);
  for (const name of TEMP_ENVIRONMENT_VARIABLES) process.env[name] = scratchTemp;
  process.on('exit', () => {
    for (const [name, value] of previousValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeScratchTemp(scratchTemp);
  });
  return scratchTemp;
}

export function removeScratchTemp(scratchTemp, remove = rmSync) {
  try {
    remove(scratchTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    process.emitWarning(`private scratch directory was left behind: ${scratchTemp}`);
  }
}
