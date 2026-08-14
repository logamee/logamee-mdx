import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'https://github.com/sunlin92/logamee-mdx';
const execFileAsync = promisify(execFile);

function cargoPackageValue(cargoToml, key) {
  const packageTable = cargoToml.match(/^\[package\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
  return packageTable.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm'))?.[1];
}

test('publishes canonical MIT project and manifest metadata', async () => {
  const [license, packageJsonText, packageLockText, cargoToml, tauriConfigText, indexHtml] = await Promise.all([
    readFile(path.join(projectRoot, 'LICENSE'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'Cargo.toml'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    readFile(path.join(projectRoot, 'index.html'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  const packageLock = JSON.parse(packageLockText);
  const tauriConfig = JSON.parse(tauriConfigText);

  assert.match(license, /^MIT License$/m);
  assert.match(license, /^Copyright \(c\) 2026 sunlin92$/m);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.equal(
    createHash('sha256').update(license).digest('hex'),
    '9d3852a60809abb4b17679b41a659341ace67db281aa268e8ae07ee64b878a0c',
  );
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.name, 'logamee-mdx');
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.packages[''].name, packageJson.name);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.repository, repository);
  assert.equal(cargoPackageValue(cargoToml, 'version'), packageJson.version);
  assert.equal(cargoPackageValue(cargoToml, 'license'), packageJson.license);
  assert.equal(cargoPackageValue(cargoToml, 'repository'), packageJson.repository);
  assert.equal(tauriConfig.productName, 'mdx');
  assert.equal(tauriConfig.identifier, 'local.mmd.editor');
  assert.equal(tauriConfig.app.windows[0].title, 'mdx Markdown Editor');
  assert.match(indexHtml, /<title>mdx Markdown Editor<\/title>/);
  assert.deepEqual(tauriConfig.bundle.resources, { '../LICENSE': 'LICENSE' });
});

test('keeps committed performance baselines on the canonical package identity', async () => {
  const [packageJsonText, baseline10kText, baseline100kText] = await Promise.all([
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'perf', 'baselines', '10k.json'), 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'perf', 'baselines', '100k.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageJsonText);

  for (const [label, baselineText] of [
    ['10k', baseline10kText],
    ['100k', baseline100kText],
  ]) {
    const baseline = JSON.parse(baselineText);
    assert.equal(baseline.app.name, packageJson.name, `${label} baseline package name`);
    assert.equal(baseline.app.version, packageJson.version, `${label} baseline package version`);
  }
});

test('keeps the Tauri GUI as the explicit default binary when helper binaries exist', async () => {
  const manifestPath = path.join(projectRoot, 'src-tauri', 'Cargo.toml');
  const { stdout } = await execFileAsync(
    'cargo',
    ['metadata', '--manifest-path', manifestPath, '--no-deps', '--format-version', '1'],
    { cwd: projectRoot },
  );
  const metadata = JSON.parse(stdout);
  const mdxPackage = metadata.packages.find((candidate) => candidate.name === 'logamee-mdx');
  assert.ok(mdxPackage, 'Cargo metadata must contain the logamee-mdx package');
  assert.equal(mdxPackage.default_run, 'mdx');

  const binaryTargets = mdxPackage.targets.filter((target) => target.kind.includes('bin'));
  assert.deepEqual(
    binaryTargets.map((target) => target.name).sort(),
    ['mdx', 'mmd_bench'],
  );
  assert.equal(
    binaryTargets.find((target) => target.name === 'mdx')?.src_path,
    path.join(projectRoot, 'src-tauri', 'src', 'main.rs'),
  );
  assert.equal(
    binaryTargets.find((target) => target.name === 'mmd_bench')?.src_path,
    path.join(projectRoot, 'src-tauri', 'src', 'bin', 'mmd_bench.rs'),
  );
  assert.deepEqual(binaryTargets.find((target) => target.name === 'mdx')?.['required-features'] ?? [], []);
  assert.deepEqual(
    binaryTargets.find((target) => target.name === 'mmd_bench')?.['required-features'],
    ['bench-cli'],
  );
  assert.deepEqual(mdxPackage.features['bench-cli'], []);
  assert.deepEqual(mdxPackage.features.default, []);
});

test('documents shipped, experimental, and planned product state without stale gaps', async () => {
  const [readme, roadmap] = await Promise.all([
    readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'ROADMAP.md'), 'utf8'),
  ]);

  for (const heading of ['## 已交付', '## 实验性能力', '## 计划路线']) {
    assert.match(readme, new RegExp(`^${heading.replaceAll('*', '\\*')}\\s*$`, 'm'));
  }
  assert.match(roadmap, /\[x\].*(五套|五种).*主题/);
  assert.match(roadmap, /\[x\].*(macOS|三平台).*CI/);
  assert.doesNotMatch(roadmap, /尚无三平台 CI/);
  assert.doesNotMatch(roadmap, /\[ \] 主题模式/);
});

test('uses only the documented roadmap status markers', async () => {
  const roadmap = await readFile(path.join(projectRoot, 'ROADMAP.md'), 'utf8');
  const markers = [...roadmap.matchAll(/^- \[([^\]]*)\]/gm)].map((match) => match[1]);
  assert.ok(markers.length > 0);
  assert.deepEqual([...new Set(markers)].sort(), [' ', 'x', '~']);
});
