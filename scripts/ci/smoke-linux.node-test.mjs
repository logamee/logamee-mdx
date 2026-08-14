import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./smoke-linux.sh', import.meta.url));

async function writeExecutable(file, contents) {
  await writeFile(file, `#!/bin/bash\nset -euo pipefail\n${contents}`);
  await chmod(file, 0o755);
}

test('installs a relative deb artifact through its absolute local path', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mmd-smoke-linux-'));
  const binDir = path.join(root, 'bin');
  const artifactName = 'artifacts with spaces';
  const artifactDir = path.join(root, artifactName);
  const deb = path.join(artifactDir, 'mdx_0.1.0_amd64.deb');
  const sudoLog = path.join(root, 'sudo.log');
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(binDir);
  await mkdir(artifactDir);
  await writeFile(deb, 'fake deb');
  await writeFile(path.join(artifactDir, 'mdx_0.1.0_amd64.AppImage'), 'fake appimage');
  await writeExecutable(path.join(binDir, 'node'), 'exit 0\n');
  await writeExecutable(path.join(binDir, 'uname'), 'printf "x86_64\\n"\n');
  await writeExecutable(path.join(binDir, 'dpkg-deb'), 'exit 0\n');
  await writeExecutable(
    path.join(binDir, 'sudo'),
    `if [[ "$1" == apt-get && "$2" == update ]]; then
  exit 0
fi
printf '%s\\n' "$@" > "$SUDO_LOG"
exit 42
`,
  );

  const result = spawnSync('/bin/bash', [script, artifactName, 'x86_64-unknown-linux-gnu'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CDPATH: root,
      PATH: `${binDir}:${process.env.PATH}`,
      SUDO_LOG: sudoLog,
    },
  });

  assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual((await readFile(sudoLog, 'utf8')).trim().split('\n'), [
    'apt-get',
    'install',
    '-y',
    await realpath(deb),
  ]);
});

test('refreshes the installed desktop database and verifies the Markdown association', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mmd-smoke-linux-association-'));
  const binDir = path.join(root, 'bin');
  const artifactDir = path.join(root, 'artifacts');
  const commandLog = path.join(root, 'commands.log');
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(binDir);
  await mkdir(artifactDir);
  await writeFile(path.join(artifactDir, 'mdx_0.1.0_amd64.deb'), 'fake deb');
  await writeFile(path.join(artifactDir, 'mdx_0.1.0_amd64.AppImage'), 'fake appimage');
  await writeExecutable(path.join(binDir, 'node'), 'exit 0\n');
  await writeExecutable(path.join(binDir, 'uname'), 'printf "x86_64\\n"\n');
  await writeExecutable(path.join(binDir, 'dpkg-deb'), 'exit 0\n');
  await writeExecutable(path.join(binDir, 'mdx'), 'exit 0\n');
  await writeExecutable(path.join(binDir, 'sudo'), 'printf "sudo %s\\n" "$*" >> "$COMMAND_LOG"\n');
  await writeExecutable(path.join(binDir, 'gio'), `printf 'gio %s\\n' "$*" >> "$COMMAND_LOG"
printf 'Default application for text/markdown: mdx.desktop\\n'
`);

  spawnSync('/bin/bash', [script, artifactDir, 'x86_64-unknown-linux-gnu'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      COMMAND_LOG: commandLog,
      PATH: `${binDir}:${process.env.PATH}`,
      RUNNER_TEMP: root,
    },
  });

  const commands = (await readFile(commandLog, 'utf8')).trim().split('\n');
  const installIndex = commands.findIndex((command) => command.startsWith('sudo apt-get install -y '));
  const refreshIndex = commands.indexOf('sudo update-desktop-database /usr/share/applications');
  const mimeIndex = commands.indexOf('gio mime text/markdown');
  assert.ok(installIndex !== -1 && refreshIndex > installIndex, 'desktop cache refresh must follow deb install');
  assert.ok(mimeIndex > refreshIndex, 'MIME ownership must be checked after refreshing the desktop cache');
});
