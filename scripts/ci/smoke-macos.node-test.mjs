import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function writeExecutable(file, contents) {
  await writeFile(file, `#!/bin/bash\nset -euo pipefail\n${contents}`);
  await chmod(file, 0o755);
}

test('installs the app locally, detaches the DMG, then launches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mmd-smoke-macos-'));
  const binDir = path.join(root, 'bin');
  const artifactDir = path.join(root, 'artifacts');
  const runnerTemp = path.join(root, 'runner-temp');
  const mountPoint = path.join(root, 'Volumes', 'mdx');
  const sourceApp = path.join(mountPoint, 'mdx.app');
  const sourceBinary = path.join(sourceApp, 'Contents', 'MacOS', 'mdx');
  const eventLog = path.join(root, 'events.log');

  await mkdir(path.dirname(sourceBinary), { recursive: true });
  await mkdir(binDir);
  await mkdir(artifactDir);
  await mkdir(runnerTemp);
  await writeFile(path.join(artifactDir, 'mdx.dmg'), 'fake dmg');
  await writeExecutable(
    sourceBinary,
    'printf "launch:%s\\n" "$0" >> "$EVENT_LOG"\n',
  );
  await writeExecutable(
    path.join(binDir, 'node'),
    `if [[ "\${1:-}" == *packaged-lifecycle-runner.mjs ]]; then
  for argument in "$@"; do app="$argument"; done
  "$app"
fi
exit 0
`,
  );
  await writeExecutable(path.join(binDir, 'uname'), 'printf "arm64\\n"\n');
  await writeExecutable(
    path.join(binDir, 'find'),
    `case "$*" in
  *"*.dmg"*) printf '%s\\n' ${JSON.stringify(path.join(artifactDir, 'mdx.dmg'))} ;;
  *"Contents/MacOS"*) printf '%s\\n' "$1/mdx" ;;
  *"mdx.app"*) printf '%s\\n' ${JSON.stringify(sourceApp)} ;;
  *) exit 1 ;;
esac
`,
  );
  await writeExecutable(
    path.join(binDir, 'hdiutil'),
    `if [[ "$1" == attach ]]; then
  printf 'attach\\n' >> "$EVENT_LOG"
  printf '/dev/disk9 Apple_HFS %s\\n' ${JSON.stringify(mountPoint)}
else
  printf 'detach:%s\\n' "$2" >> "$EVENT_LOG"
fi
`,
  );
  await writeExecutable(
    path.join(binDir, 'ditto'),
    'printf "ditto:%s:%s\\n" "$1" "$2" >> "$EVENT_LOG"\n/bin/cp -R "$1" "$2"\n',
  );
  await writeExecutable(path.join(binDir, 'lipo'), 'printf "arm64\\n"\n');
  await writeExecutable(
    path.join(binDir, 'codesign'),
    'if [[ "$1" == -dv ]]; then printf "Signature=adhoc\\n" >&2; fi\n',
  );
  await writeExecutable(
    path.join(binDir, 'sleep'),
    'printf "sleep:%s\\n" "$1" >> "$EVENT_LOG"\n/bin/sleep 0.5\n',
  );

  try {
    const result = spawnSync(
      '/bin/bash',
      ['scripts/ci/smoke-macos.sh', artifactDir, 'arm64', 'aarch64-apple-darwin'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          EVENT_LOG: eventLog,
          PATH: `${binDir}:${process.env.PATH}`,
          RUNNER_TEMP: runnerTemp,
        },
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const events = (await readFile(eventLog, 'utf8')).trim().split('\n');
    const indexOf = (prefix) => events.findIndex((event) => event.startsWith(prefix));
    const attachIndex = indexOf('attach');
    const dittoIndex = indexOf('ditto:');
    const detachIndex = indexOf('detach:');
    const launchIndex = indexOf('launch:');
    assert.notEqual(attachIndex, -1);
    assert.notEqual(dittoIndex, -1);
    assert.notEqual(detachIndex, -1);
    assert.notEqual(launchIndex, -1);
    assert.ok(attachIndex < dittoIndex);
    assert.ok(dittoIndex < detachIndex);
    assert.ok(detachIndex < launchIndex);
    assert.ok(!events.some((event) => event.startsWith('sleep:5')));

    const installedApp = events[dittoIndex].split(':').slice(2).join(':');
    const launchedBinary = events[launchIndex].slice('launch:'.length);
    assert.ok(installedApp.startsWith(`${runnerTemp}${path.sep}`));
    assert.equal(launchedBinary, path.join(installedApp, 'Contents', 'MacOS', 'mdx'));
    assert.ok(!launchedBinary.includes(`${path.sep}Volumes${path.sep}`));
    await assert.rejects(readFile(installedApp), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
