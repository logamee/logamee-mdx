import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOMPURIFY_VERSION,
  EXCALIDRAW_VERSION,
  LIBC_VERSION,
  MAMMOTH_VERSION,
  MERMAID_VERSION,
  NOTICE_SPECS,
  OBJC2_FOUNDATION_VERSION,
  WINDOWS_CORE_VERSION,
  WINDOWS_SYS_VERSION,
  WINDOWS_VERSION,
  collectSynchronizedThirdPartyNotices,
  joinPortableNoticePath,
  syncThirdPartyNotices,
} from './sync-third-party-notices.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createFixtureProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-notices-'));
  temporaryDirectories.push(root);
  const packages = [
    ['mammoth', MAMMOTH_VERSION, [['LICENSE', 'mammoth-license\n']]],
    ['dompurify', DOMPURIFY_VERSION, [
      ['LICENSE', 'dompurify-apache-license\n'],
      ['LICENSE-MPL', 'dompurify-mpl-license\n'],
    ]],
    ['@excalidraw/excalidraw', EXCALIDRAW_VERSION, []],
    ['mermaid', MERMAID_VERSION, [['LICENSE', 'mermaid-license\n']]],
  ];
  for (const [packageName, version, licenses] of packages) {
    const packageRoot = path.join(root, 'node_modules', packageName);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ version }));
    for (const [name, contents] of licenses) {
      await writeFile(path.join(packageRoot, name), contents);
    }
  }
  const staticLicenseDirectory = path.join(root, 'scripts', 'licenses');
  await mkdir(staticLicenseDirectory, { recursive: true });
  await writeFile(path.join(staticLicenseDirectory, 'excalidraw-0.18.1-LICENSE'), 'excalidraw-license\n');
  for (const spec of NOTICE_SPECS.filter(({ ecosystem }) => ecosystem === 'cargo')) {
    const destination = path.join(root, spec.sourcePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(projectRoot, spec.sourcePath)));
  }
  const cargoDirectory = path.join(root, 'src-tauri');
  await mkdir(cargoDirectory, { recursive: true });
  await writeFile(path.join(cargoDirectory, 'Cargo.lock'), [
    ['libc', LIBC_VERSION],
    ['objc2-foundation', OBJC2_FOUNDATION_VERSION],
    ['windows', WINDOWS_VERSION],
    ['windows-core', WINDOWS_CORE_VERSION],
    ['windows-sys', WINDOWS_SYS_VERSION],
  ].map(([name, version]) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`).join('\n'));
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

describe('third-party notice synchronization', () => {
  it('prevents Git from rewriting pinned license bytes on Windows', async () => {
    const attributes = await readFile(path.join(projectRoot, '.gitattributes'), 'utf8');

    expect(attributes).toContain('scripts/licenses/** -text');
    expect(attributes).toContain('public/vendor/notices/** -text -whitespace');
  });

  it('keeps logical notice paths portable across operating systems', () => {
    expect(path.win32.join('dompurify', 'LICENSE')).toBe('dompurify\\LICENSE');
    expect(joinPortableNoticePath('dompurify', 'LICENSE')).toBe('dompurify/LICENSE');
  });

  it('keeps the checked-in notices byte-identical to exact pinned packages', async () => {
    const packageManifest = JSON.parse(await readFile(
      path.join(projectRoot, 'package.json'),
      'utf8',
    ));
    expect(MAMMOTH_VERSION).toBe('1.12.0');
    expect(DOMPURIFY_VERSION).toBe('3.4.12');
    expect(EXCALIDRAW_VERSION).toBe('0.18.1');
    expect(MERMAID_VERSION).toBe('11.16.0');
    expect(LIBC_VERSION).toBe('0.2.186');
    expect(OBJC2_FOUNDATION_VERSION).toBe('0.3.2');
    expect(WINDOWS_VERSION).toBe('0.61.3');
    expect(WINDOWS_CORE_VERSION).toBe('0.61.2');
    expect(WINDOWS_SYS_VERSION).toBe('0.61.2');
    expect(packageManifest.scripts).toMatchObject({
      postinstall: 'npm run sync:vendor-assets',
      prebuild: 'npm run sync:vendor-assets',
      predev: 'npm run sync:vendor-assets',
      'sync:pdf-assets': 'node scripts/sync-pdf-assets.mjs',
      'sync:third-party-notices': 'node scripts/sync-third-party-notices.mjs',
      'sync:vendor-assets': 'npm run sync:pdf-assets && npm run sync:third-party-notices',
    });
    expect(NOTICE_SPECS.map(({ destination }) => destination)).toEqual([
      'dompurify/LICENSE',
      'dompurify/LICENSE-MPL',
      'mammoth/LICENSE',
      'excalidraw/LICENSE',
      'mermaid/LICENSE',
      'rust/libc/LICENSE-APACHE',
      'rust/libc/LICENSE-MIT',
      'rust/objc2-foundation/LICENSE-MIT',
      'rust/windows/LICENSE-APACHE',
      'rust/windows/LICENSE-MIT',
      'rust/windows-core/LICENSE-APACHE',
      'rust/windows-core/LICENSE-MIT',
      'rust/windows-sys/LICENSE-APACHE',
      'rust/windows-sys/LICENSE-MIT',
    ]);
    expect(Object.fromEntries(NOTICE_SPECS.map(({ packageName, license }) => (
      [packageName, license]
    )))).toEqual({
      dompurify: '(MPL-2.0 OR Apache-2.0)',
      mammoth: 'BSD-2-Clause',
      '@excalidraw/excalidraw': 'MIT',
      mermaid: 'MIT',
      libc: '(MIT OR Apache-2.0)',
      'objc2-foundation': 'MIT',
      windows: '(MIT OR Apache-2.0)',
      'windows-core': '(MIT OR Apache-2.0)',
      'windows-sys': '(MIT OR Apache-2.0)',
    });

    const synchronized = await collectSynchronizedThirdPartyNotices({ projectRoot });
    expect(synchronized).toHaveLength(14);
    const cargoHashMismatches = [];
    for (const entry of synchronized) {
      const source = await readFile(entry.sourcePath
        ? path.join(projectRoot, entry.sourcePath)
        : path.join(projectRoot, 'node_modules', entry.packageName, entry.sourceName));
      const copied = await readFile(path.join(
        projectRoot,
        'public',
        'vendor',
        'notices',
        entry.destination,
      ));
      expect(copied).toEqual(source);
      expect(entry.sha256).toBe(sha256(source));
      expect(entry.license).toBe(
        NOTICE_SPECS.find((spec) => spec.packageName === entry.packageName)?.license,
      );
      const spec = NOTICE_SPECS.find(({ destination }) => destination === entry.destination);
      if (spec?.ecosystem === 'cargo' && spec.sha256 !== sha256(source)) {
        cargoHashMismatches.push(entry.destination);
      }
    }
    expect(cargoHashMismatches).toEqual([]);
  });

  it('removes stale files and is idempotent with an exact output set', async () => {
    const fixtureRoot = await createFixtureProject();
    const first = await syncThirdPartyNotices({ projectRoot: fixtureRoot });
    const stalePath = path.join(
      fixtureRoot,
      'public',
      'vendor',
      'notices',
      'stale.txt',
    );
    await writeFile(stalePath, 'stale');
    const second = await syncThirdPartyNotices({ projectRoot: fixtureRoot });

    expect(second).toEqual(first);
    await expect(readFile(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(collectSynchronizedThirdPartyNotices({ projectRoot: fixtureRoot }))
      .resolves.toEqual(first);
  });

  it('fails closed on dependency version drift', async () => {
    const fixtureRoot = await createFixtureProject();
    await writeFile(
      path.join(fixtureRoot, 'node_modules', 'mammoth', 'package.json'),
      JSON.stringify({ version: '1.12.1' }),
    );

    await expect(syncThirdPartyNotices({ projectRoot: fixtureRoot }))
      .rejects.toThrow('Expected mammoth 1.12.0, found 1.12.1');
  });

  it('fails closed on native Rust dependency version drift', async () => {
    const fixtureRoot = await createFixtureProject();
    const cargoLock = path.join(fixtureRoot, 'src-tauri', 'Cargo.lock');
    await writeFile(
      cargoLock,
      (await readFile(cargoLock, 'utf8')).replace(
        `name = "libc"\nversion = "${LIBC_VERSION}"`,
        'name = "libc"\nversion = "0.2.187"',
      ),
    );

    await expect(syncThirdPartyNotices({ projectRoot: fixtureRoot }))
      .rejects.toThrow('Expected Cargo package libc 0.2.186, found 0.2.187');
  });
});
