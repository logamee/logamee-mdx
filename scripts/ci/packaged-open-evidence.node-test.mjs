import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sameEvidenceTarget } from './packaged-open-evidence.mjs';

const evidenceScript = fileURLToPath(new URL('./packaged-open-evidence.mjs', import.meta.url));

function run(arguments_) {
  return spawnSync(process.execPath, [evidenceScript, ...arguments_], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'a'.repeat(40),
    },
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function issueChallenge(t, profile = 'apply-reobserve', packageVariant = 'dmg', platform = 'macos') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-open-evidence-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const challengePath = path.join(root, 'challenge.json');
  const result = run([
    'issue', '--target', 'test-target', '--package-variant', packageVariant,
    '--platform', platform, '--profile', profile, '--output', challengePath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const challenge = JSON.parse(await readFile(challengePath, 'utf8'));
  t.after(() => rm(challenge.root, { recursive: true, force: true }));
  return { root, challengePath, challenge };
}

function issueHostPathChallenge(t, profile = 'apply-reobserve') {
  if (process.platform === 'win32') return issueChallenge(t, profile, 'nsis', 'windows');
  if (process.platform === 'darwin') return issueChallenge(t, profile, 'dmg', 'macos');
  return issueChallenge(t, profile, 'deb', 'linux');
}

function grant(kind, target, origin) {
  return { kind, path: target, origin, status: 'active', count: 1 };
}

function delta(added = [], { fileBefore = 0, fileAfter = 0, workspaceBefore = 0, workspaceAfter = 0 } = {}) {
  return {
    generationBefore: 0,
    generationAfter: added.length,
    added,
    removed: [],
    pendingFileBefore: fileBefore,
    pendingFileAfter: fileAfter,
    pendingWorkspaceBefore: workspaceBefore,
    pendingWorkspaceAfter: workspaceAfter,
  };
}

function receiptBuilder() {
  const events = [];
  const push = (actor, type, intentId, step, fields = {}) => {
    events.push({ seq: events.length + 1, actor, type, intentId, step, ...fields });
  };
  return { events, push };
}

function resequence(receipt) {
  receipt.events.forEach((event, index) => { event.seq = index + 1; });
  return receipt;
}

function baseReceipt(challenge, events) {
  const primaryPid = 4100;
  return {
    schema: 2,
    gate: 'packaged-native-open-e2e',
    status: 'passed',
    identity: {
      target: challenge.target,
      platform: challenge.platform,
      packageVariant: challenge.packageVariant,
      runId: challenge.runId,
      runAttempt: challenge.runAttempt,
      commit: challenge.commit,
      nonceDigest: digest(challenge.nonce),
      profile: challenge.profile,
    },
    primary: { pid: primaryPid, receiverPids: [primaryPid], windowCount: 1 },
    events,
    final: {
      app: {
        activeFile: challenge.scenario.paths.primaryFile,
        workspaceRoot: challenge.scenario.paths.workspaceDirectory,
        workspaceToken: 'workspace-7',
        authorityStatus: 'committed',
        dirty: false,
      },
      authorization: {
        generation: 4,
        pendingFileReceipts: 0,
        pendingWorkspaceReceipts: 0,
        grants: [],
      },
      spellcheck: {
        realEditorCount: 1,
        enabledRealEditorCount: 1,
        enabledNonEditorCount: 0,
        dictionaryConsistency: 'not_claimed',
      },
      queueEmpty: true,
    },
    association: challenge.packageVariant === 'appimage'
      ? { status: 'not_applicable', reason: 'appimage-has-no-installed-association' }
      : { status: 'verified', launcher: 'platform-native', target: challenge.scenario.paths.associationFile },
  };
}

function grantKey(item) {
  return [item.kind, item.path, item.origin, item.status].join('\0');
}

function normalizeAuthorization(receipt) {
  let generation = 0;
  let pendingFile = 0;
  let pendingWorkspace = 0;
  const grants = new Map();
  const producerGroups = [];
  for (let index = 0; index < receipt.events.length; index += 1) {
    const event = receipt.events[index];
    if (event.type === 'backend_prepared') {
      const group = [event];
      while (receipt.events[index + 1]?.type === 'backend_prepared'
        && receipt.events[index + 1].intentId === event.intentId
        && receipt.events[index + 1].step === event.step) {
        group.push(receipt.events[index + 1]);
        index += 1;
      }
      producerGroups.push(group);
    } else if (['backend_rejected', 'backend_receipt_settled'].includes(event.type)) {
      producerGroups.push([event]);
    }
  }

  for (const group of producerGroups) {
    const event = group[0];
    const before = {
      generationBefore: generation,
      pendingFileBefore: pendingFile,
      pendingWorkspaceBefore: pendingWorkspace,
    };
    const added = [];
    const removed = [];
    if (event.type === 'backend_prepared') {
      for (const prepared of group) {
        if (prepared.receiptKind === 'file') pendingFile += 1;
        else if (prepared.receiptKind === 'workspace') pendingWorkspace += 1;
      }
    } else if (event.type === 'backend_receipt_settled') {
      if (event.receiptKind === 'file') pendingFile -= 1;
      else pendingWorkspace -= 1;
      const desired = event.receiptKind === 'file'
        ? [
          grant('exact_rw', event.target, 'open_document'),
          grant('internal_asset', path.dirname(event.target), 'open_document'),
        ]
        : [
          grant('directory_read', event.target, 'workspace'),
          grant('internal_asset', event.target, 'workspace'),
        ];
      for (const next of desired) {
        const key = grantKey(next);
        const prior = grants.get(key);
        if (prior) removed.push(prior);
        const updated = { ...next, count: (prior?.count ?? 0) + 1 };
        grants.set(key, updated);
        added.push(updated);
      }
      generation += 1;
    }
    const authorizationDelta = {
      ...before,
      generationAfter: generation,
      added,
      removed,
      pendingFileAfter: pendingFile,
      pendingWorkspaceAfter: pendingWorkspace,
    };
    for (const item of group) item.authorizationDelta = structuredClone(authorizationDelta);
  }
  receipt.final.authorization = {
    generation,
    pendingFileReceipts: pendingFile,
    pendingWorkspaceReceipts: pendingWorkspace,
    grants: [...grants.values()],
  };
  return receipt;
}

function nativePreamble(challenge, push) {
  const pid = 4100;
  push('native', 'native_delivery', 'open-intent-1', 'cli-primary', {
    source: challenge.platform === 'macos' ? 'opened_event' : 'startup_args',
    target: challenge.scenario.paths.primaryFile,
    outcome: 'enqueued', receiverPid: pid,
  });
  push('native', 'session_restore_queued', 'open-intent-2', 'session-restore', { opaque: true });
  push('native', 'native_delivery', 'open-intent-3', 'cli-secondary-unicode', {
    source: 'secondary_instance', target: challenge.scenario.paths.unicodeFile,
    outcome: 'enqueued', receiverPid: pid,
  });
  push('native', 'native_delivery', 'open-intent-3', 'cli-secondary-duplicate', {
    source: 'secondary_instance', target: challenge.scenario.paths.unicodeFile,
    outcome: 'coalesced', receiverPid: pid,
  });
  push('native', 'native_delivery', 'open-intent-4', 'cli-directory', {
    source: 'secondary_instance', target: challenge.scenario.paths.workspaceDirectory,
    outcome: 'enqueued', receiverPid: pid,
  });
  push('native', 'native_delivery', 'open-intent-5', 'cli-stale', {
    source: 'secondary_instance', target: challenge.scenario.paths.staleFile,
    outcome: 'enqueued', receiverPid: pid,
  });
  if (challenge.packageVariant !== 'appimage') {
    push('native', 'native_delivery', 'open-intent-6', 'file-association', {
      source: 'opened_event', target: challenge.scenario.paths.associationFile,
      outcome: 'enqueued', receiverPid: pid,
    });
  }
}

function appliedLifecycle(push, intentId, step, target, targetKind, receiptCharacter) {
  const receiptKind = targetKind === 'directory' ? 'workspace' : 'file';
  const settlement = receiptKind === 'workspace' ? 'applied' : 'committed';
  const added = targetKind === 'directory'
    ? [grant('directory_read', target, 'workspace'), grant('internal_asset', target, 'workspace')]
    : [grant('exact_rw', target, 'open_document'), grant('internal_asset', path.dirname(target), 'open_document')];
  const pendingOptions = receiptKind === 'workspace'
    ? { workspaceAfter: 1 }
    : { fileAfter: 1 };
  const settlementOptions = receiptKind === 'workspace'
    ? { workspaceBefore: 1 }
    : { fileBefore: 1 };
  const receiptDigest = receiptCharacter.repeat(64);
  push('app', 'app_activated', intentId, step, { dirty: false, activeFileBefore: null });
  push('backend', 'backend_reobserved', intentId, step, { target, targetKind });
  push('backend', 'backend_prepared', intentId, step, {
    receiptKind, receiptDigest, target, authorizationDelta: delta([], pendingOptions),
  });
  push('backend', 'backend_receipt_settled', intentId, step, {
    receiptKind, receiptDigest, settlement, target,
    authorizationDelta: delta(added, settlementOptions),
  });
  push('app', 'app_applied', intentId, step, { status: 'accepted', targetKind });
  push('app', 'app_settled', intentId, step, { status: 'accepted' });
}

function rejectedLifecycle(push, intentId, step, target, { dirty = false } = {}) {
  push('app', 'app_activated', intentId, step, { dirty, activeFileBefore: null });
  if (dirty) {
    push('app', 'dirty_modal_opened', intentId, step, { modalId: `modal-${intentId}` });
    push('app', 'dirty_decision', intentId, step, { decision: 'discard' });
  }
  push('backend', 'backend_rejected', intentId, step, {
    target, reason: 'missing', authorizationDelta: delta([]),
  });
  push('app', 'app_settled', intentId, step, { status: 'failed' });
}

function applyReceipt(challenge) {
  const { events, push } = receiptBuilder();
  nativePreamble(challenge, push);
  push('app', 'app_activated', 'open-intent-1', 'cli-primary', { dirty: false, activeFileBefore: null });
  push('backend', 'backend_reobserved', 'open-intent-1', 'cli-primary', { target: challenge.scenario.paths.primaryFile, targetKind: 'file' });
  push('backend', 'backend_prepared', 'open-intent-1', 'cli-primary', {
    receiptKind: 'file', receiptDigest: 'a'.repeat(64), target: challenge.scenario.paths.primaryFile,
    authorizationDelta: delta([], { fileAfter: 1 }),
  });
  push('backend', 'backend_receipt_settled', 'open-intent-1', 'cli-primary', {
    receiptKind: 'file', receiptDigest: 'a'.repeat(64), settlement: 'committed', target: challenge.scenario.paths.primaryFile,
    authorizationDelta: delta([
      grant('exact_rw', challenge.scenario.paths.primaryFile, 'open_document'),
      grant('internal_asset', path.dirname(challenge.scenario.paths.primaryFile), 'open_document'),
    ], { fileBefore: 1 }),
  });
  push('app', 'app_applied', 'open-intent-1', 'cli-primary', { status: 'accepted', targetKind: 'file' });
  push('app', 'app_settled', 'open-intent-1', 'cli-primary', { status: 'accepted' });
  push('backend', 'focus_requested', 'open-intent-1', 'cli-primary');
  push('runner', 'focus_observed', 'open-intent-1', 'cli-primary', { pid: 4100, method: 'platform-active-window-pid' });

  push('app', 'app_activated', 'open-intent-2', 'session-restore', { dirty: true, activeFileBefore: challenge.scenario.paths.primaryFile });
  push('app', 'dirty_modal_opened', 'open-intent-2', 'session-restore', { modalId: 'modal-restore' });
  push('app', 'dirty_decision', 'open-intent-2', 'session-restore', { decision: 'discard' });
  push('backend', 'backend_reobserved', 'open-intent-2', 'session-restore', {
    target: 'session_restore', targetKind: 'session_restore',
  });
  push('backend', 'backend_prepared', 'open-intent-2', 'session-restore', {
    receiptKind: 'none', authorizationDelta: delta([]),
  });
  push('app', 'app_applied', 'open-intent-2', 'session-restore', { status: 'accepted', targetKind: 'session_restore' });
  push('app', 'app_settled', 'open-intent-2', 'session-restore', { status: 'accepted' });

  rejectedLifecycle(push, 'open-intent-3', 'cli-secondary-unicode', challenge.scenario.paths.unicodeFile, { dirty: true });

  push('app', 'app_activated', 'open-intent-4', 'cli-directory', { dirty: false, activeFileBefore: challenge.scenario.paths.primaryFile });
  push('backend', 'backend_reobserved', 'open-intent-4', 'cli-directory', { target: challenge.scenario.paths.workspaceDirectory, targetKind: 'directory' });
  push('backend', 'backend_prepared', 'open-intent-4', 'cli-directory', {
    receiptKind: 'workspace', receiptDigest: 'b'.repeat(64), target: challenge.scenario.paths.workspaceDirectory,
    authorizationDelta: delta([], { workspaceAfter: 1 }),
  });
  push('backend', 'backend_receipt_settled', 'open-intent-4', 'cli-directory', {
    receiptKind: 'workspace', receiptDigest: 'b'.repeat(64), settlement: 'applied', target: challenge.scenario.paths.workspaceDirectory,
    authorizationDelta: delta([
      grant('directory_read', challenge.scenario.paths.workspaceDirectory, 'workspace'),
      grant('internal_asset', challenge.scenario.paths.workspaceDirectory, 'workspace'),
    ], { workspaceBefore: 1 }),
  });
  push('app', 'app_applied', 'open-intent-4', 'cli-directory', { status: 'accepted', targetKind: 'directory' });
  push('app', 'app_settled', 'open-intent-4', 'cli-directory', { status: 'accepted' });
  rejectedLifecycle(push, 'open-intent-5', 'cli-stale', challenge.scenario.paths.staleFile);
  if (challenge.packageVariant !== 'appimage') {
    appliedLifecycle(push, 'open-intent-6', 'file-association', challenge.scenario.paths.associationFile, 'file', 'c');
  }
  return normalizeAuthorization(baseReceipt(challenge, events));
}

function restoreCancelReceipt(challenge) {
  const { events, push } = receiptBuilder();
  nativePreamble(challenge, push);
  appliedLifecycle(push, 'open-intent-1', 'cli-primary', challenge.scenario.paths.primaryFile, 'file', 'a');
  push('app', 'app_activated', 'open-intent-2', 'session-restore', { dirty: true, activeFileBefore: challenge.scenario.paths.primaryFile });
  push('app', 'dirty_modal_opened', 'open-intent-2', 'session-restore', { modalId: 'modal-restore' });
  push('app', 'dirty_decision', 'open-intent-2', 'session-restore', { decision: 'cancel' });
  push('app', 'app_settled', 'open-intent-2', 'session-restore', { status: 'cancelled' });
  rejectedLifecycle(push, 'open-intent-3', 'cli-secondary-unicode', challenge.scenario.paths.unicodeFile);
  appliedLifecycle(push, 'open-intent-4', 'cli-directory', challenge.scenario.paths.workspaceDirectory, 'directory', 'b');
  rejectedLifecycle(push, 'open-intent-5', 'cli-stale', challenge.scenario.paths.staleFile);
  if (challenge.packageVariant !== 'appimage') {
    appliedLifecycle(push, 'open-intent-6', 'file-association', challenge.scenario.paths.associationFile, 'file', 'c');
  }
  push('backend', 'focus_requested', 'open-intent-3', 'cli-secondary-unicode');
  push('runner', 'focus_observed', 'open-intent-3', 'cli-secondary-unicode', { pid: 4100, method: 'platform-active-window-pid' });
  return normalizeAuthorization(baseReceipt(challenge, events));
}

function withRestoreReceipts(receipt, challenge, receiptKinds) {
  const preparedIndex = receipt.events.findIndex((event) => (
    event.type === 'backend_prepared' && event.step === 'session-restore'
  ));
  const appliedIndex = receipt.events.findIndex((event) => (
    event.type === 'app_applied' && event.step === 'session-restore'
  ));
  receipt.events.splice(preparedIndex, 1);
  const prepared = receiptKinds.map((receiptKind, index) => ({
    actor: 'backend', type: 'backend_prepared', intentId: 'open-intent-2', step: 'session-restore',
    receiptKind, receiptDigest: String(index + 5).repeat(64),
    target: receiptKind === 'file'
      ? path.join(challenge.scenario.paths.workspaceDirectory, 'index.md')
      : challenge.scenario.paths.workspaceDirectory,
    authorizationDelta: delta([]),
  }));
  const settlements = receiptKinds.map((receiptKind, index) => ({
    actor: 'backend', type: 'backend_receipt_settled', intentId: 'open-intent-2', step: 'session-restore',
    receiptKind, receiptDigest: String(index + 5).repeat(64),
    settlement: receiptKind === 'file' ? 'committed' : 'applied',
    target: receiptKind === 'file'
      ? path.join(challenge.scenario.paths.workspaceDirectory, 'index.md')
      : challenge.scenario.paths.workspaceDirectory,
    authorizationDelta: delta([]),
  }));
  const reobserved = receipt.events.find((event) => (
    event.type === 'backend_reobserved' && event.step === 'session-restore'
  ));
  reobserved.target = (prepared.find((event) => event.receiptKind === 'workspace') ?? prepared[0]).target;
  receipt.events.splice(preparedIndex, 0, ...prepared);
  receipt.events.splice(appliedIndex - 1 + prepared.length, 0, ...settlements);
  resequence(receipt);
  return normalizeAuthorization(receipt);
}

async function verifyReceipt(t, challengePath, challenge, receipt) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmd-open-verify-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, 'receipt.json');
  const outputPath = path.join(root, 'verified.json');
  if (challenge.profile === 'apply-reobserve') {
    await rename(challenge.scenario.paths.unicodeFile, challenge.scenario.paths.renamedUnicodeFile);
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  const result = run(['verify', '--challenge', challengePath, '--receipt', receiptPath, '--output', outputPath]);
  return { result, outputPath };
}

test('issues schema-2 challenge fixtures for both packaged profiles', async (t) => {
  const { challenge } = await issueChallenge(t);
  assert.equal(challenge.schema, 2);
  assert.equal(challenge.profile, 'apply-reobserve');
  assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
  for (const fixture of ['unicodeFile', 'renamedUnicodeFile', 'workspaceDirectory']) {
    assert.ok([...path.basename(challenge.scenario.paths[fixture])]
      .some((character) => character.codePointAt(0) > 0x7f));
  }
  assert.equal(await readFile(challenge.scenario.paths.primaryFile, 'utf8'), '# primary\n');
  await assert.rejects(readFile(challenge.scenario.paths.staleFile, 'utf8'), { code: 'ENOENT' });
});

test('accepts app-applied file/workspace evidence with exact Rust authorization deltas', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const { result, outputPath } = await verifyReceipt(t, challengePath, challenge, applyReceipt(challenge));
  assert.equal(result.status, 0, result.stderr);
  const verified = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(verified.scope.cliOpen, true);
  assert.equal(verified.scope.exactAuthorization, true);
  assert.equal(verified.scope.realWebviewSpellcheckAttribute, true);
});

test('accepts Windows receipt identity without weakening exact target spelling', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { challengePath, challenge } = await issueChallenge(
    t, 'restore-cancel', 'nsis', 'windows',
  );
  const receipt = restoreCancelReceipt(challenge);

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.equal(result.status, 0, result.stderr);
});

test('accepts safe DOS and verbatim bindings through the Windows verifier', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { challengePath, challenge } = await issueChallenge(
    t, 'restore-cancel', 'nsis', 'windows',
  );
  const receipt = restoreCancelReceipt(challenge);
  const asVerbatim = (target) => (
    target.startsWith('\\\\') ? `\\\\?\\UNC\\${target.slice(2)}` : `\\\\?\\${target}`
  );
  const duplicate = receipt.events.find((event) => (
    event.type === 'native_delivery' && event.step === 'cli-secondary-duplicate'
  ));
  duplicate.target = asVerbatim(duplicate.target);
  receipt.final.app.activeFile = asVerbatim(receipt.final.app.activeFile);

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.equal(result.status, 0, result.stderr);
});

test('limits Windows target equivalence to unambiguous wire spelling differences', () => {
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\File.md', '\\\\?\\C:\\Docs\\File.md', 'windows',
  ), true);
  assert.equal(sameEvidenceTarget(
    '\\\\server\\share\\Docs\\File.md',
    '\\\\?\\UNC\\server\\share\\Docs\\File.md',
    'windows',
  ), true);
  assert.equal(sameEvidenceTarget('C:\\Docs\\File.md', 'c:/Docs/File.md', 'windows'), true);
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\File.md', '\\\\?\\C:\\Docs\\FILE.md', 'windows',
  ), false);
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\File.md', '\\\\?\\C:\\docs\\File.md', 'windows',
  ), false);
  assert.equal(sameEvidenceTarget(
    '\\\\server\\share\\Docs\\File.md',
    '\\\\?\\UNC\\SERVER\\share\\Docs\\File.md',
    'windows',
  ), false);
  assert.equal(sameEvidenceTarget(
    'C:\\secret.md', 'C:\\safe\\..\\secret.md', 'windows',
  ), false);
  assert.equal(sameEvidenceTarget(
    'C:\\secret.md', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\secret.md', 'windows',
  ), false);
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\File.md', '\\\\?\\C:/Docs/File.md', 'windows',
  ), false);
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\File.md', '\\\\?\\C:\\Docs\\File.md.', 'windows',
  ), false);
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\File.md', '\\\\?\\C:\\Docs\\File.md ', 'windows',
  ), false);
  for (const reserved of [
    'NUL.txt', 'con', 'COM1.md', 'com¹.log', 'LPT9', 'lpt³.md', 'CONIN$', 'conout$.txt',
  ]) {
    assert.equal(sameEvidenceTarget(
      `C:\\Docs\\${reserved}`, `\\\\?\\C:\\Docs\\${reserved}`, 'windows',
    ), false, reserved);
  }
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\COM10.md', '\\\\?\\C:\\Docs\\COM10.md', 'windows',
  ), true);
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\bad\u0001name.md', '\\\\?\\C:\\Docs\\bad\u0001name.md', 'windows',
  ), false);
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\File.md:stream', '\\\\?\\C:\\Docs\\File.md:stream', 'windows',
  ), false);
  for (const invalid of [
    'C:\\Docs\\.\\File.md',
    'C:\\Docs\\..\\File.md',
    'C:\\Docs\\\\File.md',
    'C:\\Docs\\File.md.',
    'C:\\Docs\\File.md ',
    'C:\\Docs\\File.md:stream',
    'C:\\Docs\\bad\u0001name.md',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\secret.md',
    '\\\\.\\C:\\Docs\\File.md',
    'C:\\Docs\\NUL.txt',
    'C:\\Docs\\COM1.md',
    '\\\\\\share\\File.md',
    '\\\\server\\\\File.md',
    'session_restore',
  ]) {
    assert.equal(sameEvidenceTarget(invalid, invalid, 'windows'), false, invalid);
  }
  assert.equal(sameEvidenceTarget(
    'C:\\Docs\\File.md', '\\\\?\\C:\\docs\\file.md', 'macos',
  ), false);
});

test('rejects a case-only Windows final authorization mismatch', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { challengePath, challenge } = await issueChallenge(
    t, 'restore-cancel', 'nsis', 'windows',
  );
  const receipt = restoreCancelReceipt(challenge);
  receipt.final.app.activeFile = receipt.final.app.activeFile.toUpperCase();

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /final active file lacks authorization/);
});

test('accepts a Windows apply-reobserve session restore receipt binding', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { challengePath, challenge } = await issueChallenge(
    t, 'apply-reobserve', 'nsis', 'windows',
  );
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace']);

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.equal(result.status, 0, result.stderr);
});

test('rejects an identical ambiguous Windows session restore target', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { challengePath, challenge } = await issueChallenge(
    t, 'apply-reobserve', 'nsis', 'windows',
  );
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace']);
  const invalidTarget = 'C:\\Docs\\..\\secret.md';
  const prepared = receipt.events.find((event) => (
    event.type === 'backend_prepared' && event.step === 'session-restore'
  ));
  const settlement = receipt.events.find((event) => (
    event.type === 'backend_receipt_settled' && event.step === 'session-restore'
  ));
  prepared.target = invalidTarget;
  settlement.target = invalidTarget;
  normalizeAuthorization(receipt);

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /receipt settlement does not match its preparation/);
});

test('accepts a zero-receipt session restore lifecycle', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const prepared = receipt.events.filter((event) => (
    event.type === 'backend_prepared' && event.step === 'session-restore'
  ));
  assert.deepEqual(prepared.map((event) => event.receiptKind), ['none']);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.equal(result.status, 0, result.stderr);
});

test('accepts session restore lifecycles with one receipt', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace']);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.equal(result.status, 0, result.stderr);
});

test('rejects a session restore lifecycle with only a file receipt', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['file']);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session restore receipt set is invalid/);
});

test('accepts session restore lifecycles with workspace and descendant file receipts', async (t) => {
  const { challengePath, challenge } = await issueHostPathChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace', 'file']);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.equal(result.status, 0, result.stderr);
});

test('rejects a session restore whose resolved target differs from its workspace receipt', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace']);
  const reobserved = receipt.events.find((event) => (
    event.type === 'backend_reobserved' && event.step === 'session-restore'
  ));
  reobserved.target = challenge.scenario.paths.primaryFile;

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /applied lifecycle binding is invalid/);
});

test('rejects a restored file outside its restored workspace', async (t) => {
  const { challengePath, challenge } = await issueHostPathChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace', 'file']);
  const fileEvents = receipt.events.filter((event) => (
    event.step === 'session-restore' && event.receiptKind === 'file'
  ));
  for (const event of fileEvents) event.target = challenge.scenario.paths.primaryFile;
  normalizeAuthorization(receipt);

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restored file is outside its workspace/);
});

test('rejects a session restore settlement for a different prepared target', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace']);
  const prepared = receipt.events.find((event) => (
    event.type === 'backend_prepared' && event.step === 'session-restore'
  ));
  prepared.target = challenge.scenario.paths.unicodeFile;
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /receipt settlement does not match its preparation/);
});

test('rejects a native settlement for a different prepared target', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const prepared = receipt.events.find((event) => (
    event.type === 'backend_prepared' && event.step === 'cli-primary'
  ));
  prepared.target = challenge.scenario.paths.unicodeFile;

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /receipt settlement does not match its preparation/);
});

test('rejects final app active file without active document authority', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.final.app.activeFile = path.join(challenge.root, 'ungranted.md');
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /final active file lacks authorization/);
});

test('rejects final app workspace root without active workspace authority', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.final.app.workspaceRoot = path.join(challenge.root, 'ungranted-workspace');
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /final workspace root lacks authorization/);
});

for (const [label, rejectedTarget] of [
  ['Unicode', 'unicodeFile'],
  ['stale', 'staleFile'],
]) {
  test(`rejects final authorization retained for the rejected ${label} target`, async (t) => {
    const { challengePath, challenge } = await issueChallenge(t);
    const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace']);
    const target = challenge.scenario.paths[rejectedTarget];
    const prepared = receipt.events.find((event) => (
      event.type === 'backend_prepared' && event.step === 'session-restore'
    ));
    const settlement = receipt.events.find((event) => (
      event.type === 'backend_receipt_settled' && event.step === 'session-restore'
    ));
    const reobserved = receipt.events.find((event) => (
      event.type === 'backend_reobserved' && event.step === 'session-restore'
    ));
    prepared.target = target;
    settlement.target = target;
    reobserved.target = target;
    normalizeAuthorization(receipt);
    const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rejected target retains final authorization/);
  });
}

test('accepts cancelled restore only when it never reaches backend resolution and the queue continues', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t, 'restore-cancel');
  const { result, outputPath } = await verifyReceipt(t, challengePath, challenge, restoreCancelReceipt(challenge));
  assert.equal(result.status, 0, result.stderr);
  const verified = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(verified.scope.sessionRestoreCancellation, true);
});

test('rejects an event ledger with a missing monotonic sequence', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.events.splice(4, 1);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /event sequence is not contiguous/);
});

test('rejects forged grants on a backend rejection', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const rejected = receipt.events.find((event) => event.type === 'backend_rejected');
  rejected.authorizationDelta.added.push(grant('exact_rw', challenge.scenario.paths.unicodeFile, 'open_document'));
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rejected target or authorization delta is invalid/);
});

test('rejects a cancelled restore that reached backend preparation', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t, 'restore-cancel');
  const receipt = restoreCancelReceipt(challenge);
  receipt.events.push({
    seq: receipt.events.length + 1,
    actor: 'backend', type: 'backend_prepared', intentId: 'open-intent-2', step: 'session-restore',
    receiptKind: 'workspace', receiptDigest: 'c'.repeat(64), authorizationDelta: delta([]),
  });
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cancelled lifecycle is invalid/);
});

test('records AppImage association as not applicable without weakening CLI evidence', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t, 'apply-reobserve', 'appimage', 'linux');
  const { result, outputPath } = await verifyReceipt(t, challengePath, challenge, applyReceipt(challenge));
  assert.equal(result.status, 0, result.stderr);
  const verified = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(verified.scope.nativeAssociation, false);
  assert.equal(verified.limitations[0].code, 'appimage-has-no-installed-association');
});

test('rejects focus observation for the wrong intent', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const observed = receipt.events.find((event) => event.type === 'focus_observed');
  observed.intentId = 'open-intent-4';
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /focus observation does not match a prior focus request/);
});

test('rejects focus observation for the wrong step', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const observed = receipt.events.find((event) => event.type === 'focus_observed');
  observed.step = 'cli-directory';
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /focus observation does not match a prior focus request/);
});

test('rejects duplicate focus observations', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const observed = receipt.events.find((event) => event.type === 'focus_observed');
  receipt.events.push({ ...observed });
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /focus lifecycle evidence is incomplete/);
});

test('rejects verified association metadata without an actual association delivery', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.events = receipt.events.filter((event) => !(
    event.type === 'native_delivery' && event.step === 'file-association'
  ));
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /association evidence lacks native delivery/);
});

test('rejects receipt settlement stitched from another intent', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const settlement = receipt.events.find((event) => (
    event.type === 'backend_receipt_settled' && event.receiptKind === 'workspace'
  ));
  settlement.intentId = 'open-intent-1';
  settlement.step = 'cli-primary';
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native receipt lifecycle is incomplete/);
});

test('rejects failed final application authority', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.final.app.authorityStatus = 'failed';
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /final app state is invalid/);
});

test('rejects apply-reobserve evidence with only the stale rejection', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const rejectedIndex = receipt.events.findIndex((event) => (
    event.type === 'backend_rejected' && event.step === 'cli-secondary-unicode'
  ));
  receipt.events.splice(rejectedIndex, 1,
    {
      actor: 'backend', type: 'backend_reobserved', intentId: 'open-intent-3',
      step: 'cli-secondary-unicode', target: challenge.scenario.paths.unicodeFile, targetKind: 'file',
    },
    {
      actor: 'backend', type: 'backend_prepared', intentId: 'open-intent-3',
      step: 'cli-secondary-unicode', receiptKind: 'file', receiptDigest: 'd'.repeat(64),
      target: challenge.scenario.paths.unicodeFile,
      authorizationDelta: delta([], { fileAfter: 1 }),
    },
    {
      actor: 'backend', type: 'backend_receipt_settled', intentId: 'open-intent-3',
      step: 'cli-secondary-unicode', receiptKind: 'file', receiptDigest: 'd'.repeat(64),
      settlement: 'committed', target: challenge.scenario.paths.unicodeFile,
      authorizationDelta: delta([
        grant('exact_rw', challenge.scenario.paths.unicodeFile, 'open_document'),
        grant('internal_asset', path.dirname(challenge.scenario.paths.unicodeFile), 'open_document'),
      ], { fileBefore: 1 }),
    },
    {
      actor: 'app', type: 'app_applied', intentId: 'open-intent-3',
      step: 'cli-secondary-unicode', status: 'accepted', targetKind: 'file',
    });
  const unicodeSettled = receipt.events.find((event) => (
    event.type === 'app_settled' && event.step === 'cli-secondary-unicode'
  ));
  unicodeSettled.status = 'accepted';
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /renamed Unicode target was not rejected separately/);
});

test('rejects an applied lifecycle with receipt settlement after app apply', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const settlementIndex = receipt.events.findIndex((event) => (
    event.type === 'backend_receipt_settled' && event.intentId === 'open-intent-1'
  ));
  const appliedIndex = receipt.events.findIndex((event) => (
    event.type === 'app_applied' && event.intentId === 'open-intent-1'
  ));
  [receipt.events[settlementIndex], receipt.events[appliedIndex]] = [
    receipt.events[appliedIndex], receipt.events[settlementIndex],
  ];
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lifecycle event order is invalid/);
});

test('rejects session restore when one of two prepared receipts is never settled', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace', 'file']);
  const settlementIndex = receipt.events.findIndex((event) => (
    event.type === 'backend_receipt_settled'
      && event.step === 'session-restore'
      && event.receiptKind === 'file'
  ));
  receipt.events.splice(settlementIndex, 1);
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session restore receipt lifecycle is incomplete/);
});

test('rejects duplicate receipt kinds in a two-receipt session restore', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['file', 'file']);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session restore receipt set is invalid/);
});

test('rejects a file receipt before the workspace receipt in a session restore', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['file', 'workspace']);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session restore receipt set is invalid/);
});

test('rejects a settlement attached to a zero-receipt session restore', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const appliedIndex = receipt.events.findIndex((event) => (
    event.type === 'app_applied' && event.step === 'session-restore'
  ));
  receipt.events.splice(appliedIndex, 0, {
    actor: 'backend', type: 'backend_receipt_settled', intentId: 'open-intent-2',
    step: 'session-restore', receiptKind: 'workspace', receiptDigest: 'f'.repeat(64),
    settlement: 'applied', target: challenge.scenario.paths.workspaceDirectory,
    authorizationDelta: delta([]),
  });
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /zero-receipt restore published receipt metadata/);
});

test('rejects dirty activation without a modal and decision on that intent', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.events = receipt.events.filter((event) => !(
    event.step === 'session-restore' && ['dirty_modal_opened', 'dirty_decision'].includes(event.type)
  ));
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session-restore dirty guard lifecycle is invalid/);
});

test('rejects a dirty modal on an activation that reported clean state', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const activated = receipt.events.find((event) => (
    event.type === 'app_activated' && event.step === 'session-restore'
  ));
  activated.dirty = false;
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session-restore dirty guard lifecycle is invalid/);
});

test('rejects a dirty decision stitched onto another intent', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const decision = receipt.events.find((event) => (
    event.type === 'dirty_decision' && event.step === 'session-restore'
  ));
  decision.intentId = 'open-intent-1';
  decision.step = 'cli-primary';
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty guard lifecycle is invalid/);
});

test('rejects activation of the next FIFO intent before the prior intent is terminal', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const nextActivationIndex = receipt.events.findIndex((event) => (
    event.type === 'app_activated' && event.step === 'session-restore'
  ));
  const [nextActivation] = receipt.events.splice(nextActivationIndex, 1);
  const priorSettlementIndex = receipt.events.findIndex((event) => (
    event.type === 'app_settled' && event.step === 'cli-primary'
  ));
  receipt.events.splice(priorSettlementIndex, 0, nextActivation);
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prior intent was not terminal before the next activation/);
});

test('rejects discontinuous authorization producer generations', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const rejected = receipt.events.find((event) => event.type === 'backend_rejected');
  rejected.authorizationDelta.generationBefore += 10;
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authorization producer state is discontinuous/);
});

test('rejects authorization grants published during receipt preparation', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const prepared = receipt.events.find((event) => (
    event.type === 'backend_prepared' && event.receiptKind === 'file'
  ));
  prepared.authorizationDelta.added.push(
    grant('exact_rw', challenge.scenario.paths.primaryFile, 'open_document'),
  );
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prepared authorization grants prematurely/);
});

test('rejects inconsistent producer deltas duplicated across two restore receipts', async (t) => {
  const { challengePath, challenge } = await issueHostPathChallenge(t);
  const receipt = withRestoreReceipts(applyReceipt(challenge), challenge, ['workspace', 'file']);
  const prepared = receipt.events.filter((event) => (
    event.type === 'backend_prepared' && event.step === 'session-restore'
  ));
  prepared[1].authorizationDelta.pendingFileAfter += 1;
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /grouped producer deltas do not match/);
});

test('rejects a file settlement that does not consume its pending receipt', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const settlement = receipt.events.find((event) => (
    event.type === 'backend_receipt_settled' && event.receiptKind === 'file'
  ));
  settlement.authorizationDelta.pendingFileAfter = settlement.authorizationDelta.pendingFileBefore;
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /file receipt pending transition is invalid/);
});

test('rejects removal of a grant absent from the producer ledger', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const settlement = receipt.events.find((event) => (
    event.type === 'backend_receipt_settled' && event.receiptKind === 'file'
  ));
  settlement.authorizationDelta.removed.push(grant(
    'exact_rw', path.join(challenge.root, 'forged.md'), 'open_document',
  ));
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /removed grant is not present in producer state/);
});

test('rejects an inflated count for a newly produced authorization grant', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const settlement = receipt.events.find((event) => (
    event.type === 'backend_receipt_settled'
      && event.step === 'cli-primary'
  ));
  const added = settlement.authorizationDelta.added.find((item) => (
    item.kind === 'exact_rw' && item.path === challenge.scenario.paths.primaryFile
  ));
  const finalGrant = receipt.final.authorization.grants.find((item) => (
    grantKey(item) === grantKey(added)
  ));
  added.count = 7;
  finalGrant.count = 7;

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /new grant count must be 1/);
});

test('rejects a skipped count in an aggregate authorization increment', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const settlement = receipt.events.find((event) => (
    event.type === 'backend_receipt_settled'
      && event.step === 'file-association'
  ));
  const added = settlement.authorizationDelta.added.find((item) => item.kind === 'internal_asset');
  const removed = settlement.authorizationDelta.removed.find((item) => (
    grantKey(item) === grantKey(added)
  ));
  const finalGrant = receipt.final.authorization.grants.find((item) => (
    grantKey(item) === grantKey(added)
  ));
  assert.equal(removed.count, 1);
  added.count = 3;
  finalGrant.count = 3;

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /aggregate grant count must increment by 1/);
});

test('rejects a settlement that removes an unrelated existing grant', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  const settlement = receipt.events.find((event) => (
    event.type === 'backend_receipt_settled'
      && event.step === 'file-association'
  ));
  const unrelated = receipt.final.authorization.grants.find((item) => (
    item.kind === 'exact_rw' && item.path === challenge.scenario.paths.primaryFile
  ));
  settlement.authorizationDelta.removed.push(structuredClone(unrelated));
  receipt.final.authorization.grants = receipt.final.authorization.grants.filter((item) => (
    grantKey(item) !== grantKey(unrelated)
  ));
  receipt.final.app.activeFile = challenge.scenario.paths.associationFile;

  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /removed grant must be re-added by the same transition/);
});

test('rejects final authorization grants that do not match producer deltas', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.final.authorization.grants.pop();
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /final authorization grants do not match producer deltas/);
});

test('rejects final authorization generation that does not match producer deltas', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.final.authorization.generation += 1;
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /final authorization counters do not match producer transitions/);
});

test('rejects an application lifecycle without a queued intent', async (t) => {
  const { challengePath, challenge } = await issueChallenge(t);
  const receipt = applyReceipt(challenge);
  receipt.events.push({
    actor: 'app', type: 'app_activated', intentId: 'open-intent-99', step: 'forged',
    dirty: false, activeFileBefore: null,
  }, {
    actor: 'app', type: 'app_settled', intentId: 'open-intent-99', step: 'forged', status: 'failed',
  });
  resequence(receipt);
  const { result } = await verifyReceipt(t, challengePath, challenge, receipt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /application lifecycle event is not bound to a queued intent/);
});
