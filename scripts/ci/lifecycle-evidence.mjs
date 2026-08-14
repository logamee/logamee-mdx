import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REQUIRED_GATES = ['durable-write-cas', 'native-trash'];
const PACKAGED_GATE = 'packaged-lifecycle-e2e';
const PACKAGE_VARIANTS = new Set(['dmg', 'nsis', 'deb', 'appimage']);
const PACKAGED_SAVED_BYTES = Buffer.from('packaged lifecycle saved\n');
const PACKAGED_COMPETING_BYTES = Buffer.from('external competing bytes\n');

function workflowIdentity() {
  return {
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    commit: process.env.GITHUB_SHA ?? 'local',
  };
}

function parse(arguments_) {
  const values = new Map();
  const separator = arguments_.indexOf('--');
  const options = separator === -1 ? arguments_ : arguments_.slice(0, separator);
  const command = separator === -1 ? [] : arguments_.slice(separator + 1);
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index];
    const value = options[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid option near ${key ?? '<end>'}`);
    const name = key.slice(2);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { values, command };
}

function one(values, name) {
  const entries = values.get(name) ?? [];
  if (entries.length !== 1 || !entries[0]) throw new Error(`exactly one --${name} is required`);
  return entries[0];
}

function many(values, name) {
  return values.get(name) ?? [];
}

function optional(values, name) {
  const entries = values.get(name) ?? [];
  if (entries.length > 1) throw new Error(`at most one --${name} is allowed`);
  return entries[0];
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function describe(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`evidence input is not a regular file: ${file}`);
  return { name: path.basename(file), size: info.size, sha256: await sha256(file) };
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashJson(value) {
  return hashBytes(Buffer.from(JSON.stringify(value)));
}

function readFixedName(bytes, offset, length) {
  const field = bytes.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString('ascii');
}

function machoTextSection(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error('expected a thin little-endian 64-bit Mach-O binary');
  }
  const commandCount = bytes.readUInt32LE(16);
  let offset = 32;
  for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
    if (offset + 8 > bytes.length) throw new Error('truncated Mach-O load command');
    const command = bytes.readUInt32LE(offset);
    const commandSize = bytes.readUInt32LE(offset + 4);
    if (commandSize < 8 || offset + commandSize > bytes.length) throw new Error('invalid Mach-O load command size');
    if (command === 0x19) {
      const sectionCount = bytes.readUInt32LE(offset + 64);
      let sectionOffset = offset + 72;
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
        if (sectionOffset + 80 > offset + commandSize) throw new Error('truncated Mach-O section table');
        const sectionName = readFixedName(bytes, sectionOffset, 16);
        const segmentName = readFixedName(bytes, sectionOffset + 16, 16);
        if (sectionName === '__text' && segmentName === '__TEXT') {
          const size = Number(bytes.readBigUInt64LE(sectionOffset + 40));
          const fileOffset = bytes.readUInt32LE(sectionOffset + 48);
          if (!Number.isSafeInteger(size) || fileOffset + size > bytes.length) throw new Error('invalid Mach-O text section range');
          return bytes.subarray(fileOffset, fileOffset + size);
        }
        sectionOffset += 80;
      }
    }
    offset += commandSize;
  }
  throw new Error('Mach-O __TEXT,__text section is missing');
}

function peTextSection(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('expected a PE binary');
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length || bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('invalid PE signature');
  }
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  let sectionOffset = peOffset + 24 + optionalHeaderSize;
  for (let index = 0; index < sectionCount; index += 1) {
    if (sectionOffset + 40 > bytes.length) throw new Error('truncated PE section table');
    const name = readFixedName(bytes, sectionOffset, 8);
    if (name === '.text') {
      const size = bytes.readUInt32LE(sectionOffset + 16);
      const fileOffset = bytes.readUInt32LE(sectionOffset + 20);
      if (fileOffset + size > bytes.length) throw new Error('invalid PE text section range');
      return bytes.subarray(fileOffset, fileOffset + size);
    }
    sectionOffset += 40;
  }
  throw new Error('PE .text section is missing');
}

function elfSafeInteger(value, description) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid ELF ${description}`);
  return number;
}

function elfFileRange(bytes, offset, size, description) {
  if (offset > bytes.length || size > bytes.length - offset) {
    throw new Error(`invalid ELF ${description} range`);
  }
  return bytes.subarray(offset, offset + size);
}

function elfTextSection(bytes) {
  if (bytes.length < 64
    || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || bytes[4] !== 2
    || bytes[5] !== 1
    || bytes[6] !== 1) {
    throw new Error('expected a little-endian 64-bit ELF binary');
  }
  if (bytes.readUInt16LE(52) < 64) throw new Error('invalid ELF header size');

  const sectionTableOffset = elfSafeInteger(bytes.readBigUInt64LE(40), 'section table offset');
  const sectionHeaderSize = bytes.readUInt16LE(58);
  const sectionCount = bytes.readUInt16LE(60);
  const stringTableIndex = bytes.readUInt16LE(62);
  if (sectionHeaderSize < 64 || sectionCount === 0) throw new Error('invalid ELF section table dimensions');
  if (stringTableIndex === 0xffff || stringTableIndex >= sectionCount) {
    throw new Error('invalid ELF section-name string table index');
  }
  elfFileRange(bytes, sectionTableOffset, sectionHeaderSize * sectionCount, 'section table');

  function sectionHeader(index) {
    const offset = sectionTableOffset + (index * sectionHeaderSize);
    return {
      nameOffset: bytes.readUInt32LE(offset),
      type: bytes.readUInt32LE(offset + 4),
      flags: bytes.readBigUInt64LE(offset + 8),
      fileOffset: elfSafeInteger(bytes.readBigUInt64LE(offset + 24), 'section offset'),
      size: elfSafeInteger(bytes.readBigUInt64LE(offset + 32), 'section size'),
    };
  }

  const stringTableHeader = sectionHeader(stringTableIndex);
  if (stringTableHeader.type !== 3) throw new Error('ELF section-name table is not a string table');
  const stringTable = elfFileRange(
    bytes,
    stringTableHeader.fileOffset,
    stringTableHeader.size,
    'section-name string table',
  );

  function sectionName(nameOffset) {
    if (nameOffset >= stringTable.length) throw new Error('invalid ELF section name offset');
    const end = stringTable.indexOf(0, nameOffset);
    if (end === -1) throw new Error('unterminated ELF section name');
    return stringTable.subarray(nameOffset, end).toString('ascii');
  }

  const textSections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const header = sectionHeader(index);
    if (sectionName(header.nameOffset) !== '.text') continue;
    if (header.type !== 1 || (header.flags & 0x4n) === 0n || header.size === 0) {
      throw new Error('ELF .text section is not executable file-backed code');
    }
    textSections.push(elfFileRange(bytes, header.fileOffset, header.size, '.text section'));
  }
  if (textSections.length !== 1) throw new Error('ELF must contain exactly one .text section');
  return textSections[0];
}

async function executableIdentity(file, format) {
  const bytes = await readFile(file);
  if (format === 'exact') return { algorithm: 'file-sha256', sha256: hashBytes(bytes) };
  if (format === 'macho-text') return { algorithm: 'macho-__TEXT,__text-sha256', sha256: hashBytes(machoTextSection(bytes)) };
  if (format === 'pe-text') return { algorithm: 'pe-.text-sha256', sha256: hashBytes(peTextSection(bytes)) };
  if (format === 'elf-text') return { algorithm: 'elf-.text-sha256', sha256: hashBytes(elfTextSection(bytes)) };
  throw new Error(`unsupported identity format: ${format}`);
}

async function describeBinary(file, format) {
  return { ...(await describe(file)), identity: await executableIdentity(file, format) };
}

async function writeJsonAtomic(output, value) {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, output);
}

function runChild(command, arguments_, env = process.env) {
  const result = spawnSync(command, arguments_, { env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by signal ${result.signal}`);
  return result.status ?? 1;
}

function listCargoTest(target, filter, ignored) {
  const arguments_ = [
    'test', '--manifest-path', 'src-tauri/Cargo.toml', '--target', target,
    '--release', filter, '--', '--exact', '--list',
  ];
  if (ignored) arguments_.push('--ignored');
  const result = spawnSync('cargo', arguments_, { encoding: 'utf8', env: process.env, shell: false });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) return result.status ?? 1;
  const listed = (result.stdout ?? '').split(/\r?\n/).some((line) => line === `${filter}: test`);
  if (!listed) throw new Error(`cargo test filter did not select exactly one test: ${filter}`);
  return 0;
}

async function recordPassedGate({ gate, target, output }) {
  await writeJsonAtomic(output, {
    schema: 1,
    gate,
    target,
    status: 'passed',
    ...workflowIdentity(),
  });
}

async function runGate(arguments_) {
  const { values, command } = parse(arguments_);
  const gate = one(values, 'gate');
  const target = one(values, 'target');
  const output = one(values, 'output');
  if (command.length === 0) throw new Error('run-gate requires a command after --');
  await rm(output, { force: true });
  const status = runChild(command[0], command.slice(1));
  if (status !== 0) return status;
  await recordPassedGate({ gate, target, output });
  return 0;
}

async function runCargoTests(arguments_) {
  const { values, command } = parse(arguments_);
  if (command.length !== 0) throw new Error('run-cargo-tests does not accept a command');
  const gate = one(values, 'gate');
  const target = one(values, 'target');
  const output = one(values, 'output');
  const filters = many(values, 'filter');
  const ignored = optional(values, 'ignored') === 'true';
  if (filters.length === 0) throw new Error('at least one --filter is required');
  await rm(output, { force: true });
  for (const filter of filters) {
    const listStatus = listCargoTest(target, filter, ignored);
    if (listStatus !== 0) return listStatus;
    const testArguments = [
      'test', '--manifest-path', 'src-tauri/Cargo.toml', '--target', target,
      '--release', filter, '--', '--exact', '--test-threads=1',
    ];
    if (ignored) testArguments.push('--ignored');
    const status = runChild('cargo', [
      ...testArguments,
    ]);
    if (status !== 0) return status;
  }
  await recordPassedGate({ gate, target, output });
  return 0;
}

async function readReceipt(file, target, identity) {
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  if (receipt.schema !== 1 || receipt.status !== 'passed') throw new Error(`invalid passed-gate receipt: ${file}`);
  if (receipt.target !== target) throw new Error(`receipt target mismatch: ${file}`);
  for (const field of ['runId', 'runAttempt', 'commit']) {
    if (receipt[field] !== identity[field]) throw new Error(`receipt ${field} mismatch: ${file}`);
  }
  return receipt;
}

async function finalize(arguments_) {
  const { values, command } = parse(arguments_);
  if (command.length !== 0) throw new Error('finalize does not accept a command');
  const target = one(values, 'target');
  const sourcePath = one(values, 'source-binary');
  const identityFormat = optional(values, 'identity-format') ?? 'exact';
  const output = one(values, 'output');
  const packagedPaths = many(values, 'packaged-binary');
  const packagePaths = many(values, 'package');
  const packageVariants = many(values, 'package-variant');
  const receiptPaths = many(values, 'receipt');
  if (packagedPaths.length === 0 || packagePaths.length === 0) {
    throw new Error('at least one --packaged-binary and --package are required');
  }
  if (packagedPaths.length !== packagePaths.length) {
    throw new Error('--packaged-binary and --package counts must match');
  }
  if (packageVariants.length > 0 && packageVariants.length !== packagePaths.length) {
    throw new Error('--package-variant count must match package count');
  }
  if (packageVariants.some((variant) => !PACKAGE_VARIANTS.has(variant))) {
    throw new Error('unsupported package variant');
  }
  if (new Set(packageVariants).size !== packageVariants.length) {
    throw new Error('package variants must be unique');
  }

  const identity = workflowIdentity();
  const receipts = [];
  for (const file of receiptPaths) receipts.push(await readReceipt(file, target, identity));
  const gates = receipts.map(({ gate }) => gate).sort();
  if (JSON.stringify(gates) !== JSON.stringify(REQUIRED_GATES)) {
    throw new Error(`required gate receipts missing or duplicated: expected ${REQUIRED_GATES.join(', ')}`);
  }

  const source = await describeBinary(sourcePath, identityFormat);
  const packaged = [];
  for (const file of packagedPaths) packaged.push(await describeBinary(file, identityFormat));
  if (packaged.some(({ identity }) => identity.sha256 !== source.identity.sha256)) {
    throw new Error('packaged main binary identity mismatch');
  }

  const packages = [];
  for (const file of packagePaths) packages.push(await describe(file));
  packages.sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(packages.map(({ name }) => name)).size !== packages.length) {
    throw new Error('package basenames must be unique');
  }

  const variantEvidence = packageVariants.map((packageVariant, index) => ({
    packageVariant,
    package: packages.find(({ name }) => name === path.basename(packagePaths[index])),
    packagedBinary: packaged[index],
  })).sort((left, right) => left.packageVariant.localeCompare(right.packageVariant));

  await writeJsonAtomic(output, {
    schema: 1,
    target,
    ...identity,
    gates: receipts.map(({ gate, status }) => ({ gate, status })).sort((left, right) => left.gate.localeCompare(right.gate)),
    mainBinary: { source, packaged },
    packages,
    packageVariants: variantEvidence,
    scope: {
      nativeMutationGates: true,
      packagedMainBinaryIdentity: true,
      packagedMutationE2e: false,
      limitation: 'CAS and Trash run against the target-native test binary; package extraction proves main-binary identity, not GUI-driven mutation E2E.',
    },
  });
  return 0;
}


async function readBaseEvidence(file) {
  const evidence = JSON.parse(await readFile(file, 'utf8'));
  if (evidence.schema !== 1 || evidence.scope?.packagedMutationE2e !== false) {
    throw new Error('expected unverified base lifecycle evidence');
  }
  if (!Array.isArray(evidence.packageVariants) || evidence.packageVariants.length === 0) {
    throw new Error('base evidence does not map package variants to packaged binaries');
  }
  return evidence;
}

function findVariant(evidence, packageVariant) {
  const matches = evidence.packageVariants.filter((entry) => entry.packageVariant === packageVariant);
  if (matches.length !== 1) throw new Error(`base evidence does not contain exactly one ${packageVariant} variant`);
  return matches[0];
}

async function issuePackagedChallenge(arguments_) {
  const { values, command } = parse(arguments_);
  if (command.length !== 0) throw new Error('issue-packaged-challenge does not accept a command');
  const evidencePath = one(values, 'evidence');
  const packageVariant = one(values, 'package-variant');
  const output = one(values, 'output');
  const evidence = await readBaseEvidence(evidencePath);
  const identity = workflowIdentity();
  for (const field of ['runId', 'runAttempt', 'commit']) {
    if (evidence[field] !== identity[field]) throw new Error(`base evidence ${field} mismatch`);
  }
  findVariant(evidence, packageVariant);

  const nonce = randomBytes(32).toString('hex');
  const root = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', nonce);
  await rm(root, { recursive: true, force: true });
  await writeJsonAtomic(output, {
    schema: 1,
    nonce,
    root,
    controlPath: path.join(root, 'workspace', 'control.md'),
    stalePath: path.join(root, 'workspace', 'save-stale.md'),
    receiptPath: path.join(root, 'workspace', 'receipt.md'),
    packageVariant,
    target: evidence.target,
    ...identity,
    evidenceDigest: hashJson(evidence),
  });
  return 0;
}

function expectHex(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`packaged receipt ${field} is invalid`);
  }
}

function validatePackagedReceipt(receipt, challenge, variant) {
  const exact = {
    schema: 2,
    gate: PACKAGED_GATE,
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
  };
  for (const [field, expected] of Object.entries(exact)) {
    if (receipt[field] !== expected) throw new Error(`packaged receipt ${field} mismatch`);
  }
  expectHex(receipt.currentExeSha256, 'currentExeSha256');
  if (receipt.currentExeSha256 !== variant.packagedBinary.sha256) {
    throw new Error('packaged receipt current executable identity mismatch');
  }
  expectHex(receipt.nonceDigest, 'nonceDigest');
  if (receipt.nonceDigest !== hashBytes(Buffer.from(challenge.nonce))) {
    throw new Error('packaged receipt nonce mismatch');
  }

  const save = receipt.saveSuccess;
  for (const field of ['beforeSha256', 'intendedSha256', 'afterSha256', 'expectedVersionSha256', 'returnedVersionSha256']) {
    expectHex(save?.[field], `saveSuccess.${field}`);
  }
  if (save.response !== 'confirmed_committed' || save.exactBytes !== true
      || save.beforeSha256 !== save.expectedVersionSha256
      || save.intendedSha256 !== save.afterSha256
      || save.afterSha256 !== save.returnedVersionSha256) {
    throw new Error('packaged receipt successful CAS proof is invalid');
  }

  const stale = receipt.staleCas;
  for (const field of ['beforeSha256', 'externalSha256', 'afterSha256']) {
    expectHex(stale?.[field], `staleCas.${field}`);
  }
  if (stale.response !== 'conflict' || stale.externalBytesPreserved !== true
      || stale.externalSha256 !== stale.afterSha256) {
    throw new Error('packaged receipt stale CAS proof is invalid');
  }

  if (!Array.isArray(receipt.trash) || receipt.trash.length !== 2) {
    throw new Error('packaged receipt Trash proof is invalid');
  }
  const trashKinds = receipt.trash.map((entry) => entry.kind);
  if (JSON.stringify(trashKinds) !== JSON.stringify(['file', 'non-empty-directory'])
      || receipt.trash.some((entry) => entry.response !== 'confirmed-committed'
        || entry.sourceAbsent !== true
        || entry.placementProof !== 'native-recovery-receipt-exact-identity')) {
    throw new Error('packaged receipt Trash proof is invalid');
  }
}

async function requireMissing(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`packaged lifecycle Trash source still exists: ${file}`);
}

async function validatePackagedFilesystem(challenge, receipt) {
  const workspace = path.join(challenge.root, 'workspace');
  const saved = await readFile(path.join(workspace, 'save-success.md'));
  if (!saved.equals(PACKAGED_SAVED_BYTES)
      || receipt.saveSuccess.afterSha256 !== hashBytes(saved)) {
    throw new Error('packaged lifecycle successful save filesystem mismatch');
  }
  const stale = await readFile(challenge.stalePath);
  if (!stale.equals(PACKAGED_COMPETING_BYTES)
      || receipt.staleCas.afterSha256 !== hashBytes(stale)) {
    throw new Error('packaged lifecycle stale CAS filesystem mismatch');
  }
  await requireMissing(path.join(workspace, 'trash-file.md'));
  await requireMissing(path.join(workspace, 'trash-dir'));
}

async function verifyPackaged(arguments_) {
  const { values, command } = parse(arguments_);
  if (command.length !== 0) throw new Error('verify-packaged does not accept a command');
  const evidencePath = one(values, 'evidence');
  const artifactDirectory = one(values, 'artifact-directory');
  const challengePaths = many(values, 'packaged-challenge');
  const output = one(values, 'output');
  const evidence = await readBaseEvidence(evidencePath);
  if (challengePaths.length !== evidence.packageVariants.length) {
    throw new Error('every package variant must have exactly one packaged challenge');
  }

  for (const expected of evidence.packages) {
    const actual = await describe(path.join(artifactDirectory, expected.name));
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`package identity mismatch: ${expected.name}`);
    }
  }

  const receipts = [];
  for (const challengePath of challengePaths) {
    const challenge = JSON.parse(await readFile(challengePath, 'utf8'));
    if (challenge.schema !== 1 || challenge.evidenceDigest !== hashJson(evidence)) {
      throw new Error(`packaged challenge evidence mismatch: ${challengePath}`);
    }
    for (const field of ['target', 'runId', 'runAttempt', 'commit']) {
      if (challenge[field] !== evidence[field]) throw new Error(`packaged challenge ${field} mismatch`);
    }
    const expectedRoot = path.join(os.tmpdir(), 'mmd-packaged-lifecycle-e2e', challenge.nonce);
    if (!/^[0-9a-f]{64}$/.test(challenge.nonce)
        || challenge.root !== expectedRoot
        || challenge.controlPath !== path.join(expectedRoot, 'workspace', 'control.md')
        || challenge.stalePath !== path.join(expectedRoot, 'workspace', 'save-stale.md')
        || challenge.receiptPath !== path.join(expectedRoot, 'workspace', 'receipt.md')) {
      throw new Error(`packaged challenge fixed path mismatch: ${challengePath}`);
    }
    const variant = findVariant(evidence, challenge.packageVariant);
    const receipt = JSON.parse(await readFile(challenge.receiptPath, 'utf8'));
    validatePackagedReceipt(receipt, challenge, variant);
    await validatePackagedFilesystem(challenge, receipt);
    receipts.push(receipt);
  }
  const expectedVariants = evidence.packageVariants.map(({ packageVariant }) => packageVariant).sort();
  const actualVariants = receipts.map(({ packageVariant }) => packageVariant).sort();
  if (new Set(actualVariants).size !== actualVariants.length
      || JSON.stringify(actualVariants) !== JSON.stringify(expectedVariants)) {
    throw new Error('packaged receipt variants are missing or duplicated');
  }

  await writeJsonAtomic(output, {
    ...evidence,
    packagedMutationReceipts: receipts.sort((left, right) => left.packageVariant.localeCompare(right.packageVariant)),
    scope: {
      ...evidence.scope,
      packagedMutationE2e: true,
      packagedMutationE2eKind: 'instrumented-webview-ipc',
      uiDriven: false,
      releaseArtifactEquivalent: false,
      limitation: 'Packaged mutation evidence uses a CI-only instrumented WebView IPC path and is not UI-driven or release-artifact-equivalent.',
    },
  });
  return 0;
}

const [operation, ...arguments_] = process.argv.slice(2);
try {
  let status;
  if (operation === 'run-gate') status = await runGate(arguments_);
  else if (operation === 'run-cargo-tests') status = await runCargoTests(arguments_);
  else if (operation === 'finalize') status = await finalize(arguments_);
  else if (operation === 'issue-packaged-challenge') status = await issuePackagedChallenge(arguments_);
  else if (operation === 'verify-packaged') status = await verifyPackaged(arguments_);
  else throw new Error('usage: lifecycle-evidence.mjs run-gate|run-cargo-tests|finalize|issue-packaged-challenge|verify-packaged [options]');
  process.exitCode = status;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
