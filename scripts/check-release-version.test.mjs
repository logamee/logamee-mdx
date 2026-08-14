import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkReleaseVersion } from './check-release-version.mjs';

const script = fileURLToPath(new URL('./check-release-version.mjs', import.meta.url));

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-release-version-'));
  await mkdir(path.join(root, 'src-tauri'));
  const versions = {
    packageJson: '0.1.0',
    packageLock: '0.1.0',
    cargo: '0.1.0',
    tauri: '0.1.0',
    ...overrides,
  };
  const packageLockRoot = overrides.packageLockRoot ?? versions.packageLock;
  const packageLockPackage = overrides.packageLockPackage ?? versions.packageLock;
  const cargoToml = overrides.cargoToml
    ?? `[package]\nname = "mmd"\nversion = "${versions.cargo}"\n`;
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: versions.packageJson }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
    version: packageLockRoot,
    packages: { '': { version: packageLockPackage } },
  }));
  await writeFile(path.join(root, 'src-tauri', 'Cargo.toml'), cargoToml);
  await writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: versions.tauri }));
  return root;
}

test('checks both package-lock version locations independently', async () => {
  const root = await fixture({ packageLockPackage: '0.2.0' });
  await assert.rejects(
    checkReleaseVersion(root, { GITHUB_REF_TYPE: 'branch' }),
    /package-lock\.json packages\[""\]: expected 0\.1\.0, found 0\.2\.0/,
  );
});

test('rejects invalid semantic versions', async () => {
  for (const version of ['01.0.0', '1.0.0-01', '1.0.0-alpha.01']) {
    const root = await fixture({ packageJson: version });
    await assert.rejects(
      checkReleaseVersion(root, { GITHUB_REF_TYPE: 'branch' }),
      /package\.json: invalid semantic version/,
    );
  }
});

test('does not read a version from a later Cargo table', async () => {
  const root = await fixture({
    cargoToml: '[package]\nname = "mmd"\n\n[package.metadata.release]\nversion = "0.1.0"\n',
  });
  await assert.rejects(
    checkReleaseVersion(root, { GITHUB_REF_TYPE: 'branch' }),
    /src-tauri\/Cargo\.toml: missing \[package\] version/,
  );
});

test('accepts matching repository versions on a branch', async () => {
  const root = await fixture();
  assert.equal(await checkReleaseVersion(root, { GITHUB_REF_TYPE: 'branch' }), '0.1.0');
});

test('writes the checked version to the GitHub output file', async () => {
  const root = await fixture();
  const output = path.join(root, 'github-output');

  const result = spawnSync(process.execPath, [script, '--github-output'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      GITHUB_REF_TYPE: 'branch',
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(output, 'utf8'), 'version=0.1.0\n');
});

for (const [field, file] of [
  ['packageLock', 'package-lock.json'],
  ['cargo', 'src-tauri/Cargo.toml'],
  ['tauri', 'src-tauri/tauri.conf.json'],
]) {
  test(`reports a mismatch in ${file}`, async () => {
    const root = await fixture({ [field]: '0.2.0' });
    await assert.rejects(
      checkReleaseVersion(root, { GITHUB_REF_TYPE: 'branch' }),
      new RegExp(`${file.replaceAll('.', '\\.')}: expected 0\\.1\\.0, found 0\\.2\\.0`),
    );
  });
}

test('accepts a matching v-prefixed semver tag', async () => {
  const root = await fixture();
  assert.equal(await checkReleaseVersion(root, {
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v0.1.0',
  }), '0.1.0');
});

for (const tag of ['0.1.0', 'latest', 'v0.2.0']) {
  test(`rejects invalid or mismatched tag ${tag}`, async () => {
    const root = await fixture();
    await assert.rejects(
      checkReleaseVersion(root, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag }),
      /release tag/,
    );
  });
}
