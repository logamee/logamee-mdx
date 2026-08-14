import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAMMOTH_VERSION = '1.12.0';
export const DOMPURIFY_VERSION = '3.4.12';
export const EXCALIDRAW_VERSION = '0.18.1';
export const MERMAID_VERSION = '11.16.0';
export const LIBC_VERSION = '0.2.186';
export const OBJC2_FOUNDATION_VERSION = '0.3.2';
export const WINDOWS_VERSION = '0.61.3';
export const WINDOWS_CORE_VERSION = '0.61.2';
export const WINDOWS_SYS_VERSION = '0.61.2';

function cargoNotice({ destination, license, packageName, sha256, sourceName, version }) {
  return Object.freeze({
    destination: `rust/${packageName}/${destination}`,
    ecosystem: 'cargo',
    license,
    packageName,
    sha256,
    sourceName,
    sourcePath: `scripts/licenses/rust/${sourceName}`,
    version,
  });
}

export const NOTICE_SPECS = Object.freeze([
  Object.freeze({
    destination: 'dompurify/LICENSE',
    license: '(MPL-2.0 OR Apache-2.0)',
    packageName: 'dompurify',
    sourceName: 'LICENSE',
    version: DOMPURIFY_VERSION,
  }),
  Object.freeze({
    destination: 'dompurify/LICENSE-MPL',
    license: '(MPL-2.0 OR Apache-2.0)',
    packageName: 'dompurify',
    sourceName: 'LICENSE-MPL',
    version: DOMPURIFY_VERSION,
  }),
  Object.freeze({
    destination: 'mammoth/LICENSE',
    license: 'BSD-2-Clause',
    packageName: 'mammoth',
    sourceName: 'LICENSE',
    version: MAMMOTH_VERSION,
  }),
  // The published Excalidraw package contains only its distributable files.
  // Keep the upstream v0.18.1 license alongside this pinned integration.
  Object.freeze({
    destination: 'excalidraw/LICENSE',
    license: 'MIT',
    packageName: '@excalidraw/excalidraw',
    sourceName: 'LICENSE',
    sourcePath: 'scripts/licenses/excalidraw-0.18.1-LICENSE',
    version: EXCALIDRAW_VERSION,
  }),
  Object.freeze({
    destination: 'mermaid/LICENSE',
    license: 'MIT',
    packageName: 'mermaid',
    sourceName: 'LICENSE',
    version: MERMAID_VERSION,
  }),
  cargoNotice({
    destination: 'LICENSE-APACHE',
    license: '(MIT OR Apache-2.0)',
    packageName: 'libc',
    sha256: '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a',
    sourceName: 'libc-0.2.186-LICENSE-APACHE',
    version: LIBC_VERSION,
  }),
  cargoNotice({
    destination: 'LICENSE-MIT',
    license: '(MIT OR Apache-2.0)',
    packageName: 'libc',
    sha256: '123a331b5dbf04c30097fa43b8f858bc85df671fe776de498d01f3d6b7c1f69e',
    sourceName: 'libc-0.2.186-LICENSE-MIT',
    version: LIBC_VERSION,
  }),
  cargoNotice({
    destination: 'LICENSE-MIT',
    license: 'MIT',
    packageName: 'objc2-foundation',
    sha256: '7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54',
    sourceName: 'objc2-foundation-0.3.2-LICENSE.md',
    version: OBJC2_FOUNDATION_VERSION,
  }),
  ...[
    ['windows', WINDOWS_VERSION],
    ['windows-core', WINDOWS_CORE_VERSION],
    ['windows-sys', WINDOWS_SYS_VERSION],
  ].flatMap(([packageName, version]) => [
    cargoNotice({
      destination: 'LICENSE-APACHE',
      license: '(MIT OR Apache-2.0)',
      packageName,
      sha256: 'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
      sourceName: `${packageName}-${version}-license-apache-2.0`,
      version,
    }),
    cargoNotice({
      destination: 'LICENSE-MIT',
      license: '(MIT OR Apache-2.0)',
      packageName,
      sha256: 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383',
      sourceName: `${packageName}-${version}-license-mit`,
      version,
    }),
  ]),
]);

const projectRootFromModule = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function resolvePaths(projectRoot) {
  return {
    nodeModulesRoot: path.join(projectRoot, 'node_modules'),
    publicRoot: path.join(projectRoot, 'public', 'vendor', 'notices'),
  };
}

function noticeSourcePath(projectRoot, nodeModulesRoot, spec) {
  return spec.sourcePath
    ? path.join(projectRoot, spec.sourcePath)
    : path.join(nodeModulesRoot, spec.packageName, spec.sourceName);
}

export function joinPortableNoticePath(prefix, name) {
  return path.posix.join(prefix, name);
}

async function collectRelativeFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = joinPortableNoticePath(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRelativeFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function assertPinnedPackageVersions(nodeModulesRoot) {
  const expectedVersions = new Map(NOTICE_SPECS.filter((spec) => spec.ecosystem !== 'cargo').map((spec) => (
    [spec.packageName, spec.version]
  )));
  for (const [packageName, expectedVersion] of expectedVersions) {
    const packageJson = JSON.parse(await readFile(
      path.join(nodeModulesRoot, packageName, 'package.json'),
      'utf8',
    ));
    if (packageJson.version !== expectedVersion) {
      throw new Error(
        `Expected ${packageName} ${expectedVersion}, found ${String(packageJson.version)}`,
      );
    }
  }
}

function cargoPackageVersions(lockContents) {
  const versions = new Map();
  for (const packageBlock of lockContents.split('[[package]]').slice(1)) {
    const name = packageBlock.match(/^\s*name = "([^"]+)"/m)?.[1];
    const version = packageBlock.match(/^\s*version = "([^"]+)"/m)?.[1];
    if (name && version) {
      const packageVersions = versions.get(name) ?? new Set();
      packageVersions.add(version);
      versions.set(name, packageVersions);
    }
  }
  return versions;
}

async function assertPinnedCargoVersions(projectRoot) {
  const versions = cargoPackageVersions(await readFile(
    path.join(projectRoot, 'src-tauri', 'Cargo.lock'),
    'utf8',
  ));
  const expectedVersions = new Map(NOTICE_SPECS.filter((spec) => spec.ecosystem === 'cargo').map((spec) => (
    [spec.packageName, spec.version]
  )));
  for (const [packageName, expectedVersion] of expectedVersions) {
    const actualVersions = versions.get(packageName) ?? new Set();
    if (!actualVersions.has(expectedVersion)) {
      throw new Error(
        `Expected Cargo package ${packageName} ${expectedVersion}, found ${[...actualVersions].sort().join(', ') || 'undefined'}`,
      );
    }
  }
}

export async function collectSynchronizedThirdPartyNotices({
  projectRoot = projectRootFromModule,
} = {}) {
  const { nodeModulesRoot, publicRoot } = resolvePaths(projectRoot);
  await Promise.all([
    assertPinnedPackageVersions(nodeModulesRoot),
    assertPinnedCargoVersions(projectRoot),
  ]);

  const expectedFiles = NOTICE_SPECS.map(({ destination }) => destination).sort();
  const actualFiles = await collectRelativeFiles(publicRoot);
  if (actualFiles.length !== expectedFiles.length
    || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error('Third-party notices are not synchronized');
  }

  const synchronized = [];
  for (const spec of NOTICE_SPECS) {
    const [sourceBytes, copiedBytes] = await Promise.all([
      readFile(noticeSourcePath(projectRoot, nodeModulesRoot, spec)),
      readFile(path.join(publicRoot, spec.destination)),
    ]);
    const sourceHash = sha256Bytes(sourceBytes);
    if (spec.sha256 && sourceHash !== spec.sha256) {
      throw new Error(`Pinned third-party notice hash mismatch: ${spec.sourcePath}`);
    }
    if (sourceHash !== sha256Bytes(copiedBytes)) {
      throw new Error(`Third-party notice hash mismatch: ${spec.destination}`);
    }
    synchronized.push({
      destination: spec.destination,
      license: spec.license,
      packageName: spec.packageName,
      sha256: sourceHash,
      sourceName: spec.sourceName,
      sourcePath: spec.sourcePath ?? null,
    });
  }
  return synchronized;
}

export async function syncThirdPartyNotices({
  projectRoot = projectRootFromModule,
} = {}) {
  const { nodeModulesRoot, publicRoot } = resolvePaths(projectRoot);
  await Promise.all([
    assertPinnedPackageVersions(nodeModulesRoot),
    assertPinnedCargoVersions(projectRoot),
  ]);
  await rm(publicRoot, { force: true, recursive: true });

  for (const spec of NOTICE_SPECS) {
    const destination = path.join(publicRoot, spec.destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(
      noticeSourcePath(projectRoot, nodeModulesRoot, spec),
      destination,
    );
  }
  return collectSynchronizedThirdPartyNotices({ projectRoot });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await syncThirdPartyNotices();
}
