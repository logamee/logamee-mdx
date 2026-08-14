import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function assertMacOSBundleMainBinary({ appBundle, mainBinary }) {
  const executableDirectory = path.join(appBundle, 'Contents', 'MacOS');
  const entries = await readdir(executableDirectory, { withFileTypes: true });
  const packagedEntries = entries
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(packagedEntries, ['mdx']);
  assert.ok(entries[0]?.isFile(), 'packaged mdx must be a regular file');
  assert.equal(await sha256(path.join(executableDirectory, 'mdx')), await sha256(mainBinary));
}

test('accepts a macOS app containing only the GUI executable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-main-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appBundle = path.join(root, 'mdx.app');
  const packagedBinary = path.join(appBundle, 'Contents', 'MacOS', 'mdx');
  const mainBinary = path.join(root, 'mdx');
  await mkdir(path.dirname(packagedBinary), { recursive: true });
  await Promise.all([writeFile(packagedBinary, 'gui'), writeFile(mainBinary, 'gui')]);
  await Promise.all([chmod(packagedBinary, 0o755), chmod(mainBinary, 0o755)]);

  await assertMacOSBundleMainBinary({ appBundle, mainBinary });
});

test('rejects a helper executable bundled beside the GUI', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appBundle = path.join(root, 'mdx.app');
  const executableDirectory = path.join(appBundle, 'Contents', 'MacOS');
  const mainBinary = path.join(root, 'mdx');
  await mkdir(executableDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(executableDirectory, 'mdx'), 'gui'),
    writeFile(path.join(executableDirectory, 'mmd_bench'), 'bench'),
    writeFile(mainBinary, 'gui'),
  ]);

  await assert.rejects(
    assertMacOSBundleMainBinary({ appBundle, mainBinary }),
    /mmd_bench/,
  );
});

test('rejects a helper symlink bundled beside the GUI', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-packaged-helper-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appBundle = path.join(root, 'mdx.app');
  const executableDirectory = path.join(appBundle, 'Contents', 'MacOS');
  const packagedBinary = path.join(executableDirectory, 'mdx');
  const mainBinary = path.join(root, 'mdx');
  await mkdir(executableDirectory, { recursive: true });
  await Promise.all([writeFile(packagedBinary, 'gui'), writeFile(mainBinary, 'gui')]);
  await symlink(mainBinary, path.join(executableDirectory, 'mmd_bench'));

  await assert.rejects(
    assertMacOSBundleMainBinary({ appBundle, mainBinary }),
    /mmd_bench/,
  );
});

if (process.env.MMD_APP_BUNDLE || process.env.MMD_MAIN_BINARY) {
  test('the built macOS app contains only the verified GUI executable', async () => {
    assert.ok(process.env.MMD_APP_BUNDLE, 'MMD_APP_BUNDLE is required');
    assert.ok(process.env.MMD_MAIN_BINARY, 'MMD_MAIN_BINARY is required');
    await assertMacOSBundleMainBinary({
      appBundle: process.env.MMD_APP_BUNDLE,
      mainBinary: process.env.MMD_MAIN_BINARY,
    });
  });
}
