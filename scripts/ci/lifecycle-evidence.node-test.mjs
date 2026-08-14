import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./lifecycle-evidence.mjs', import.meta.url));

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
      ...env,
    },
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-lifecycle-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'mmd');
  const packaged = path.join(root, 'packaged-mmd');
  const artifact = path.join(root, 'mdx.test');
  await Promise.all([
    writeFile(source, 'same-main-binary'),
    writeFile(packaged, 'same-main-binary'),
    writeFile(artifact, 'package'),
  ]);
  return { root, source, packaged, artifact };
}

async function gateReceipts(root) {
  const receipts = [];
  for (const gate of ['durable-write-cas', 'native-trash']) {
    const receipt = path.join(root, `${gate}.json`);
    assert.equal(run([
      'run-gate', '--gate', gate, '--target', 'test-target', '--output', receipt,
      '--', process.execPath, '-e', 'process.exit(0)',
    ]).status, 0);
    receipts.push(receipt);
  }
  return receipts;
}

function minimalMachO(metadataByte) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(152, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(152, 36);
  bytes.writeUInt32LE(1, 96);
  bytes.write('__text', 104, 'ascii');
  bytes.write('__TEXT', 120, 'ascii');
  bytes.writeBigUInt64LE(4n, 144);
  bytes.writeUInt32LE(400, 152);
  bytes[300] = metadataByte;
  bytes.write('CODE', 400, 'ascii');
  return bytes;
}

function minimalPe(metadataByte) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64, 'binary');
  bytes.writeUInt16LE(1, 70);
  bytes.writeUInt16LE(0, 84);
  bytes.write('.text', 88, 'ascii');
  bytes.writeUInt32LE(4, 104);
  bytes.writeUInt32LE(400, 108);
  bytes[20] = metadataByte;
  bytes.write('CODE', 400, 'ascii');
  return bytes;
}

function minimalElf(metadataByte, text = 'CODE') {
  const bytes = Buffer.alloc(512);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 40);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(3, 60);
  bytes.writeUInt16LE(1, 62);

  bytes.writeUInt32LE(1, 128);
  bytes.writeUInt32LE(3, 132);
  bytes.writeBigUInt64LE(300n, 152);
  bytes.writeBigUInt64LE(17n, 160);

  bytes.writeUInt32LE(11, 192);
  bytes.writeUInt32LE(1, 196);
  bytes.writeBigUInt64LE(6n, 200);
  bytes.writeBigUInt64LE(400n, 216);
  bytes.writeBigUInt64LE(4n, 224);

  bytes[280] = metadataByte;
  bytes.write('\0.shstrtab\0.text\0', 300, 'ascii');
  bytes.write(text, 400, 'ascii');
  return bytes;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function packagedReceipt(challenge, currentExeSha256) {
  const savedDigest = digest('packaged lifecycle saved\n');
  const competingDigest = digest('external competing bytes\n');
  return {
    schema: 2,
    gate: 'packaged-lifecycle-e2e',
    status: 'passed',
    target: challenge.target,
    runId: challenge.runId,
    runAttempt: challenge.runAttempt,
    commit: challenge.commit,
    buildFlavor: 'ci-instrumented-packaged-e2e',
    instrumentationFeature: 'packaged-lifecycle-e2e',
    packageVariant: challenge.packageVariant,
    packagedAppProcess: true,
    tauriRuntime: true,
    webviewBootstrap: true,
    normalInvokeHandlers: true,
    uiDriven: false,
    releaseArtifactEquivalent: false,
    currentExeSha256,
    nonceDigest: digest(challenge.nonce),
    saveSuccess: {
      beforeSha256: '1'.repeat(64),
      intendedSha256: savedDigest,
      afterSha256: savedDigest,
      expectedVersionSha256: '1'.repeat(64),
      returnedVersionSha256: savedDigest,
      response: 'confirmed_committed',
      exactBytes: true,
    },
    staleCas: {
      beforeSha256: '3'.repeat(64),
      externalSha256: competingDigest,
      afterSha256: competingDigest,
      response: 'conflict',
      externalBytesPreserved: true,
    },
    trash: ['file', 'non-empty-directory'].map((kind) => ({
      kind,
      response: 'confirmed-committed',
      sourceAbsent: true,
      placementProof: 'native-recovery-receipt-exact-identity',
    })),
  };
}

async function writeObservedWorkspace(challenge) {
  await mkdir(path.dirname(challenge.receiptPath), { recursive: true });
  await Promise.all([
    writeFile(path.join(challenge.root, 'workspace', 'save-success.md'), 'packaged lifecycle saved\n'),
    writeFile(challenge.stalePath, 'external competing bytes\n'),
  ]);
}

test('records a gate receipt only after the child command succeeds', async (t) => {
  const { root } = await fixture(t);
  const receipt = path.join(root, 'cas.json');

  const result = run([
    'run-gate', '--gate', 'durable-write-cas', '--target', 'test-target',
    '--output', receipt, '--', process.execPath, '-e', 'process.exit(0)',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(value.gate, 'durable-write-cas');
  assert.equal(value.target, 'test-target');
  assert.equal(value.status, 'passed');
  assert.equal(value.runId, '123');
  assert.equal(value.runAttempt, '2');
  assert.equal(value.commit, 'a'.repeat(40));
});

test('does not record a gate receipt when the child command fails', async (t) => {
  const { root } = await fixture(t);
  const receipt = path.join(root, 'trash.json');

  const result = run([
    'run-gate', '--gate', 'native-trash', '--target', 'test-target',
    '--output', receipt, '--', process.execPath, '-e', 'process.exit(7)',
  ]);

  assert.equal(result.status, 7);
  await assert.rejects(readFile(receipt, 'utf8'), /ENOENT/);
});

test('creates target evidence that binds passed gates, packages, and identical main binaries', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const casReceipt = path.join(root, 'cas.json');
  const trashReceipt = path.join(root, 'trash.json');
  const output = path.join(root, 'm2-lifecycle-evidence.json');
  for (const [gate, receipt] of [['durable-write-cas', casReceipt], ['native-trash', trashReceipt]]) {
    assert.equal(run([
      'run-gate', '--gate', gate, '--target', 'test-target', '--output', receipt,
      '--', process.execPath, '-e', 'process.exit(0)',
    ]).status, 0);
  }

  const result = run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--packaged-binary', packaged, '--package', artifact,
    '--receipt', casReceipt, '--receipt', trashReceipt, '--output', output,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(evidence.schema, 1);
  assert.deepEqual(evidence.gates.map(({ gate }) => gate), ['durable-write-cas', 'native-trash']);
  assert.equal(evidence.mainBinary.source.identity.sha256, evidence.mainBinary.packaged[0].identity.sha256);
  assert.deepEqual(evidence.packages.map(({ name }) => name), ['mdx.test']);
  assert.equal(evidence.scope.packagedMutationE2e, false);
});

test('issues a package-specific challenge bound to base evidence identities', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const [cas, trash] = await gateReceipts(root);
  const evidence = path.join(root, 'evidence.json');
  const challenge = path.join(root, 'challenge.json');
  assert.equal(run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--package-variant', 'dmg', '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', evidence,
  ]).status, 0);

  const result = run([
    'issue-packaged-challenge', '--evidence', evidence, '--package-variant', 'dmg',
    '--output', challenge,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(await readFile(challenge, 'utf8'));
  assert.match(value.nonce, /^[0-9a-f]{64}$/);
  assert.equal(value.receiptPath, path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', value.nonce, 'workspace', 'receipt.md'));
  assert.equal(value.controlPath, path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', value.nonce, 'workspace', 'control.md'));
  assert.equal(value.stalePath, path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', value.nonce, 'workspace', 'save-stale.md'));
  assert.equal(value.packageVariant, 'dmg');
  assert.equal(value.target, 'test-target');
  assert.equal(value.runId, '123');
  assert.equal(value.runAttempt, '2');
  assert.equal(value.commit, 'a'.repeat(40));
  t.after(() => rm(value.root, { recursive: true, force: true }));
});

test('upgrades evidence only after every package returns a matching packaged receipt', async (t) => {
  const { root, source } = await fixture(t);
  const appImage = path.join(root, 'mdx.AppImage');
  const deb = path.join(root, 'mdx.deb');
  const appImageBinary = path.join(root, 'mmd-appimage');
  const debBinary = path.join(root, 'mmd-deb');
  await Promise.all([
    writeFile(appImage, 'appimage'), writeFile(deb, 'deb'),
    writeFile(appImageBinary, 'same-main-binary'), writeFile(debBinary, 'same-main-binary'),
  ]);
  const [cas, trash] = await gateReceipts(root);
  const baseEvidence = path.join(root, 'base-evidence.json');
  const verifiedEvidence = path.join(root, 'verified', 'm2-lifecycle-evidence.json');
  assert.equal(run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--package-variant', 'appimage', '--packaged-binary', appImageBinary, '--package', appImage,
    '--package-variant', 'deb', '--packaged-binary', debBinary, '--package', deb,
    '--receipt', cas, '--receipt', trash, '--output', baseEvidence,
  ]).status, 0);

  const challenges = [];
  for (const packageVariant of ['appimage', 'deb']) {
    const challengePath = path.join(root, `${packageVariant}.challenge.json`);
    assert.equal(run([
      'issue-packaged-challenge', '--evidence', baseEvidence, '--package-variant', packageVariant,
      '--output', challengePath,
    ]).status, 0);
    const challenge = JSON.parse(await readFile(challengePath, 'utf8'));
    t.after(() => rm(challenge.root, { recursive: true, force: true }));
    const expectedBinary = packageVariant === 'appimage' ? appImageBinary : debBinary;
    await writeObservedWorkspace(challenge);
    await writeFile(challenge.receiptPath, `${JSON.stringify(packagedReceipt(challenge, digest(await readFile(expectedBinary))))}\n`);
    challenges.push(challengePath);
  }

  const result = run([
    'verify-packaged', '--evidence', baseEvidence, '--artifact-directory', root,
    '--packaged-challenge', challenges[0], '--packaged-challenge', challenges[1],
    '--output', verifiedEvidence,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(verifiedEvidence, 'utf8'));
  assert.equal(evidence.scope.packagedMutationE2e, true);
  assert.equal(evidence.scope.packagedMutationE2eKind, 'instrumented-webview-ipc');
  assert.equal(evidence.scope.uiDriven, false);
  assert.equal(evidence.scope.releaseArtifactEquivalent, false);
  assert.deepEqual(evidence.packagedMutationReceipts.map(({ packageVariant }) => packageVariant), ['appimage', 'deb']);
});

test('rejects packaged evidence when a package changed after base evidence was created', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const [cas, trash] = await gateReceipts(root);
  const evidence = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  assert.equal(run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--package-variant', 'dmg', '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', evidence,
  ]).status, 0);
  assert.equal(run([
    'issue-packaged-challenge', '--evidence', evidence, '--package-variant', 'dmg',
    '--output', challengePath,
  ]).status, 0);
  const challenge = JSON.parse(await readFile(challengePath, 'utf8'));
  t.after(() => rm(challenge.root, { recursive: true, force: true }));
  await writeObservedWorkspace(challenge);
  await writeFile(challenge.receiptPath, `${JSON.stringify(packagedReceipt(challenge, digest(await readFile(packaged))))}\n`);
  await writeFile(artifact, 'tampered-package');

  const result = run([
    'verify-packaged', '--evidence', evidence, '--artifact-directory', root,
    '--packaged-challenge', challengePath, '--output', path.join(root, 'verified.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package identity mismatch/);
});

test('rejects a packaged receipt with a stale nonce digest', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const [cas, trash] = await gateReceipts(root);
  const evidence = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  assert.equal(run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--package-variant', 'dmg', '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', evidence,
  ]).status, 0);
  assert.equal(run([
    'issue-packaged-challenge', '--evidence', evidence, '--package-variant', 'dmg',
    '--output', challengePath,
  ]).status, 0);
  const challenge = JSON.parse(await readFile(challengePath, 'utf8'));
  t.after(() => rm(challenge.root, { recursive: true, force: true }));
  const receipt = packagedReceipt(challenge, digest(await readFile(packaged)));
  receipt.nonceDigest = '2'.repeat(64);
  await writeObservedWorkspace(challenge);
  await writeFile(challenge.receiptPath, `${JSON.stringify(receipt)}\n`);

  const result = run([
    'verify-packaged', '--evidence', evidence, '--artifact-directory', root,
    '--packaged-challenge', challengePath, '--output', path.join(root, 'verified.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packaged receipt nonce mismatch/);
});

test('rejects a receipt whose claimed successful bytes do not match the final filesystem', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const [cas, trash] = await gateReceipts(root);
  const evidence = path.join(root, 'evidence.json');
  const challengePath = path.join(root, 'challenge.json');
  assert.equal(run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--package-variant', 'dmg', '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', evidence,
  ]).status, 0);
  assert.equal(run([
    'issue-packaged-challenge', '--evidence', evidence, '--package-variant', 'dmg',
    '--output', challengePath,
  ]).status, 0);
  const challenge = JSON.parse(await readFile(challengePath, 'utf8'));
  t.after(() => rm(challenge.root, { recursive: true, force: true }));
  await writeObservedWorkspace(challenge);
  await writeFile(path.join(challenge.root, 'workspace', 'save-success.md'), 'substituted bytes\n');
  await writeFile(challenge.receiptPath, `${JSON.stringify(packagedReceipt(challenge, digest(await readFile(packaged))))}\n`);

  const result = run([
    'verify-packaged', '--evidence', evidence, '--artifact-directory', root,
    '--packaged-challenge', challengePath, '--output', path.join(root, 'verified.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /successful save filesystem mismatch/);
});

test('rejects final evidence when the packaged main binary differs', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const casReceipt = path.join(root, 'cas.json');
  const trashReceipt = path.join(root, 'trash.json');
  await writeFile(packaged, 'different-main-binary');
  for (const [gate, receipt] of [['durable-write-cas', casReceipt], ['native-trash', trashReceipt]]) {
    assert.equal(run([
      'run-gate', '--gate', gate, '--target', 'test-target', '--output', receipt,
      '--', process.execPath, '-e', 'process.exit(0)',
    ]).status, 0);
  }

  const result = run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--packaged-binary', packaged, '--package', artifact,
    '--receipt', casReceipt, '--receipt', trashReceipt,
    '--output', path.join(root, 'evidence.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packaged main binary identity mismatch/);
});

test('rejects a receipt from another target', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const receipt = path.join(root, 'cas.json');
  assert.equal(run([
    'run-gate', '--gate', 'durable-write-cas', '--target', 'other-target',
    '--output', receipt, '--', process.execPath, '-e', 'process.exit(0)',
  ]).status, 0);

  const result = run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--packaged-binary', packaged, '--package', artifact,
    '--receipt', receipt, '--output', path.join(root, 'evidence.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /receipt target mismatch/);
});

test('rejects final evidence when a required gate receipt is omitted', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const receipt = path.join(root, 'cas.json');
  assert.equal(run([
    'run-gate', '--gate', 'durable-write-cas', '--target', 'test-target',
    '--output', receipt, '--', process.execPath, '-e', 'process.exit(0)',
  ]).status, 0);

  const result = run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--packaged-binary', packaged, '--package', artifact,
    '--receipt', receipt, '--output', path.join(root, 'evidence.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required gate receipts missing or duplicated/);
});

test('rejects a receipt from another workflow attempt', async (t) => {
  const { root, source, packaged, artifact } = await fixture(t);
  const receipt = path.join(root, 'cas.json');
  assert.equal(run([
    'run-gate', '--gate', 'durable-write-cas', '--target', 'test-target',
    '--output', receipt, '--', process.execPath, '-e', 'process.exit(0)',
  ], { GITHUB_RUN_ATTEMPT: '1' }).status, 0);

  const result = run([
    'finalize', '--target', 'test-target', '--source-binary', source,
    '--packaged-binary', packaged, '--package', artifact,
    '--receipt', receipt, '--output', path.join(root, 'evidence.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /receipt runAttempt mismatch/);
});

test('accepts Mach-O binaries with identical text despite different signing metadata', async (t) => {
  const { root, artifact } = await fixture(t);
  const source = path.join(root, 'source-macho');
  const packaged = path.join(root, 'packaged-macho');
  await Promise.all([writeFile(source, minimalMachO(1)), writeFile(packaged, minimalMachO(2))]);
  const [cas, trash] = await gateReceipts(root);

  const result = run([
    'finalize', '--target', 'test-target', '--identity-format', 'macho-text',
    '--source-binary', source, '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', path.join(root, 'evidence.json'),
  ]);

  assert.equal(result.status, 0, result.stderr);
});

test('accepts PE binaries with identical text despite different signing metadata', async (t) => {
  const { root, artifact } = await fixture(t);
  const source = path.join(root, 'source.exe');
  const packaged = path.join(root, 'packaged.exe');
  await Promise.all([writeFile(source, minimalPe(1)), writeFile(packaged, minimalPe(2))]);
  const [cas, trash] = await gateReceipts(root);

  const result = run([
    'finalize', '--target', 'test-target', '--identity-format', 'pe-text',
    '--source-binary', source, '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', path.join(root, 'evidence.json'),
  ]);

  assert.equal(result.status, 0, result.stderr);
});

test('accepts ELF binaries with identical executable text despite different package metadata', async (t) => {
  const { root, artifact } = await fixture(t);
  const source = path.join(root, 'source-elf');
  const packaged = path.join(root, 'packaged-elf');
  const output = path.join(root, 'evidence.json');
  await Promise.all([writeFile(source, minimalElf(1)), writeFile(packaged, minimalElf(2))]);
  const [cas, trash] = await gateReceipts(root);

  const result = run([
    'finalize', '--target', 'test-target', '--identity-format', 'elf-text',
    '--source-binary', source, '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', output,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(evidence.mainBinary.source.identity.algorithm, 'elf-.text-sha256');
  assert.equal(evidence.mainBinary.packaged[0].identity.algorithm, 'elf-.text-sha256');
});

test('rejects ELF binaries whose executable text differs', async (t) => {
  const { root, artifact } = await fixture(t);
  const source = path.join(root, 'source-elf');
  const packaged = path.join(root, 'packaged-elf');
  await Promise.all([writeFile(source, minimalElf(1)), writeFile(packaged, minimalElf(1, 'FAIL'))]);
  const [cas, trash] = await gateReceipts(root);

  const result = run([
    'finalize', '--target', 'test-target', '--identity-format', 'elf-text',
    '--source-binary', source, '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', path.join(root, 'evidence.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packaged main binary identity mismatch/);
});

test('rejects malformed ELF section tables instead of weakening identity checks', async (t) => {
  const { root, artifact } = await fixture(t);
  const source = path.join(root, 'source-elf');
  const packaged = path.join(root, 'packaged-elf');
  const malformed = minimalElf(1);
  malformed.writeBigUInt64LE(480n, 40);
  await Promise.all([writeFile(source, malformed), writeFile(packaged, minimalElf(1))]);
  const [cas, trash] = await gateReceipts(root);

  const result = run([
    'finalize', '--target', 'test-target', '--identity-format', 'elf-text',
    '--source-binary', source, '--packaged-binary', packaged, '--package', artifact,
    '--receipt', cas, '--receipt', trash, '--output', path.join(root, 'evidence.json'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid ELF section table range/);
});
