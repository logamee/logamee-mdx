import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const GATE = 'packaged-native-open-e2e';
const SCHEMA = 2;
const PACKAGE_VARIANTS = new Set(['dmg', 'nsis', 'deb', 'appimage']);
const PLATFORMS = new Set(['macos', 'windows', 'linux']);
const PROFILES = new Set(['apply-reobserve', 'restore-cancel']);
const ACTORS = new Set(['native', 'backend', 'app', 'runner']);
const EXPECTED_VARIANT_PLATFORM = new Map([
  ['dmg', 'macos'],
  ['nsis', 'windows'],
  ['deb', 'linux'],
  ['appimage', 'linux'],
]);

function parse(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid option near ${key ?? '<end>'}`);
    const name = key.slice(2);
    if (values.has(name)) throw new Error(`--${name} must not be repeated`);
    values.set(name, value);
  }
  return values;
}

function one(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`exactly one --${name} is required`);
  return value;
}

function workflowIdentity() {
  return {
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    commit: process.env.GITHUB_SHA ?? 'local',
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJsonAtomic(output, value) {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, output);
}

function validateVariantPlatform(packageVariant, platform) {
  if (!PACKAGE_VARIANTS.has(packageVariant)) throw new Error(`unsupported package variant: ${packageVariant}`);
  if (!PLATFORMS.has(platform)) throw new Error(`unsupported platform: ${platform}`);
  if (EXPECTED_VARIANT_PLATFORM.get(packageVariant) !== platform) {
    throw new Error(`${packageVariant} is not a ${platform} package variant`);
  }
}

async function issue(arguments_) {
  const values = parse(arguments_);
  const target = one(values, 'target');
  const packageVariant = one(values, 'package-variant');
  const platform = one(values, 'platform');
  const profile = one(values, 'profile');
  const output = one(values, 'output');
  validateVariantPlatform(packageVariant, platform);
  if (!PROFILES.has(profile)) throw new Error(`unsupported evidence profile: ${profile}`);

  const nonce = randomBytes(32).toString('hex');
  const root = path.join(await realpath(os.tmpdir()), 'mmd-packaged-native-open-e2e', nonce);
  const fixtures = path.join(root, 'fixtures with spaces');
  const workspaceDirectory = path.join(fixtures, '工作区 space');
  const paths = {
    primaryFile: path.join(fixtures, 'primary.md'),
    unicodeFile: path.join(fixtures, '文档 space.md'),
    renamedUnicodeFile: path.join(fixtures, '文档 renamed.md'),
    associationFile: path.join(fixtures, 'association.md'),
    workspaceDirectory,
    staleFile: path.join(fixtures, 'removed stale.md'),
  };
  await mkdir(workspaceDirectory, { recursive: true });
  await Promise.all([
    writeFile(paths.primaryFile, '# primary\n', { flag: 'wx' }),
    writeFile(paths.unicodeFile, '# unicode\n', { flag: 'wx' }),
    writeFile(paths.associationFile, '# association\n', { flag: 'wx' }),
    writeFile(path.join(workspaceDirectory, 'index.md'), '# workspace\n', { flag: 'wx' }),
  ]);

  await writeJsonAtomic(output, {
    schema: SCHEMA,
    gate: GATE,
    target,
    packageVariant,
    platform,
    profile,
    ...workflowIdentity(),
    nonce,
    root,
    receiptPath: path.join(root, 'receipt.json'),
    controlPath: path.join(root, 'control.json'),
    scenario: { paths },
  });
}

function requireRecord(value, description) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function requireSafePositiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${description} is invalid`);
  return value;
}

function requireExactIdentity(receipt, challenge) {
  if (receipt.schema !== SCHEMA || receipt.gate !== GATE || receipt.status !== 'passed') {
    throw new Error('receipt schema, gate, or status mismatch');
  }
  const identity = requireRecord(receipt.identity, 'receipt identity');
  const expected = {
    target: challenge.target,
    platform: challenge.platform,
    packageVariant: challenge.packageVariant,
    runId: challenge.runId,
    runAttempt: challenge.runAttempt,
    commit: challenge.commit,
    nonceDigest: digest(challenge.nonce),
    profile: challenge.profile,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (identity[field] !== value) throw new Error(`receipt identity ${field} mismatch`);
  }
}

function validateEvents(receipt) {
  if (!Array.isArray(receipt.events) || receipt.events.length === 0) {
    throw new Error('receipt events must be non-empty');
  }
  for (let index = 0; index < receipt.events.length; index += 1) {
    const event = requireRecord(receipt.events[index], `event ${index + 1}`);
    if (event.seq !== index + 1) throw new Error('event sequence is not contiguous');
    if (!ACTORS.has(event.actor)) throw new Error(`event ${event.seq} actor is invalid`);
    if (typeof event.type !== 'string' || event.type.length === 0) throw new Error(`event ${event.seq} type is invalid`);
    if (!/^open-intent-[1-9][0-9]*$/.test(event.intentId)) throw new Error(`event ${event.seq} intentId is invalid`);
    if (typeof event.step !== 'string' || event.step.length === 0) throw new Error(`event ${event.seq} step is invalid`);
  }
  return receipt.events;
}

function nativeDeliveryEvents(events) {
  return events.filter((event) => event.type === 'native_delivery');
}

const LIFECYCLE_TYPES = new Set([
  'app_activated', 'dirty_modal_opened', 'dirty_decision', 'backend_reobserved',
  'backend_prepared', 'backend_rejected', 'backend_receipt_settled',
  'app_applied', 'app_settled',
]);

function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}

function exactlyOne(events, type, identity) {
  const matches = eventsOfType(events, type);
  if (matches.length !== 1) throw new Error(`${identity} must contain exactly one ${type}`);
  return matches[0];
}

function assertOrder(identity, ordered) {
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].seq >= ordered[index].seq) {
      throw new Error(`${identity} lifecycle event order is invalid`);
    }
  }
}

function normalizeWindowsEvidenceTarget(target) {
  const verbatim = target.startsWith('\\\\?\\');
  if (verbatim && target.includes('/')) return null;
  const normalized = verbatim ? target : target.replaceAll('/', '\\');
  const drive = normalized.match(verbatim
    ? /^\\\\\?\\([a-z]):\\(.*)$/i
    : /^([a-z]):\\(.*)$/i);
  if (drive) {
    const components = drive[2].split('\\');
    if (!components.every(isUnambiguousWindowsComponent)) return null;
    return `${drive[1].toLowerCase()}:\\${components.join('\\')}`;
  }

  const unc = normalized.match(verbatim
    ? /^\\\\\?\\unc\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/i
    : /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/);
  if (!unc) return null;
  const components = [unc[1], unc[2], ...(unc[3] === undefined ? [] : unc[3].split('\\'))];
  if (!components.every(isUnambiguousWindowsComponent)) return null;
  return `\\\\${components.join('\\')}`;
}

const WINDOWS_RESERVED_DEVICE_BASENAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', 'CLOCK$',
]);

function containsWindowsControlCharacter(component) {
  return [...component].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isUnambiguousWindowsComponent(component) {
  const deviceBasename = component.split('.', 1)[0].toUpperCase();
  return component.length > 0
    && component !== '.'
    && component !== '..'
    && !component.endsWith('.')
    && !component.endsWith(' ')
    && !containsWindowsControlCharacter(component)
    && !/[<>:"|?*]/.test(component)
    && !WINDOWS_RESERVED_DEVICE_BASENAMES.has(deviceBasename)
    && !/^(?:COM|LPT)(?:[1-9¹²³])$/u.test(deviceBasename);
}

export function sameEvidenceTarget(left, right, platform) {
  if (platform !== 'windows') return left === right;
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalizedLeft = normalizeWindowsEvidenceTarget(left);
  const normalizedRight = normalizeWindowsEvidenceTarget(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft === normalizedRight;
}

function validateNativeDelivery(receipt, challenge, events) {
  const primary = requireRecord(receipt.primary, 'primary process evidence');
  const primaryPid = requireSafePositiveInteger(primary.pid, 'primary pid');
  if (primary.windowCount !== 1 || JSON.stringify(primary.receiverPids) !== JSON.stringify([primaryPid])) {
    throw new Error('single-primary-instance evidence mismatch');
  }
  const deliveries = nativeDeliveryEvents(events);
  if (deliveries.length < 2) throw new Error('native delivery evidence is incomplete');
  for (const delivery of deliveries) {
    if (delivery.receiverPid !== primaryPid) throw new Error(`${delivery.step} receiver process mismatch`);
    if (!['enqueued', 'coalesced'].includes(delivery.outcome)) throw new Error(`${delivery.step} outcome is invalid`);
    if (typeof delivery.target !== 'string' || delivery.target.length === 0) throw new Error(`${delivery.step} target is invalid`);
  }
  const unicode = deliveries.find((event) => event.step === 'cli-secondary-unicode' && event.outcome === 'enqueued');
  const duplicate = deliveries.find((event) => event.step === 'cli-secondary-duplicate');
  if (!unicode || !sameEvidenceTarget(unicode.target, challenge.scenario.paths.unicodeFile, challenge.platform)
    || !duplicate || !sameEvidenceTarget(duplicate.target, challenge.scenario.paths.unicodeFile, challenge.platform)
    || duplicate.outcome !== 'coalesced' || duplicate.intentId !== unicode.intentId) {
    throw new Error('duplicate native delivery was not coalesced onto the original intent');
  }
  const requiredTargets = new Map([
    ['cli-primary', challenge.scenario.paths.primaryFile],
    ['cli-directory', challenge.scenario.paths.workspaceDirectory],
    ['cli-stale', challenge.scenario.paths.staleFile],
  ]);
  for (const [step, target] of requiredTargets) {
    if (!deliveries.some((event) => (
      event.step === step
        && sameEvidenceTarget(event.target, target, challenge.platform)
        && event.outcome === 'enqueued'
    ))) {
      throw new Error(`${step} native delivery evidence is missing`);
    }
  }
  const restore = events.find((event) => event.type === 'session_restore_queued');
  if (!restore || restore.opaque !== true || 'target' in restore || 'path' in restore) {
    throw new Error('session restore was not queued opaquely');
  }
  const association = requireRecord(receipt.association, 'association evidence');
  if (challenge.packageVariant === 'appimage') {
    if (association.status !== 'not_applicable' || association.reason !== 'appimage-has-no-installed-association') {
      throw new Error('AppImage association limitation is invalid');
    }
  } else {
    const associationDelivery = deliveries.find((event) => (
      event.step === 'file-association'
        && sameEvidenceTarget(event.target, challenge.scenario.paths.associationFile, challenge.platform)
        && event.outcome === 'enqueued'
    ));
    if (association.status !== 'verified'
      || association.launcher !== 'platform-native'
      || !sameEvidenceTarget(association.target, challenge.scenario.paths.associationFile, challenge.platform)
      || !associationDelivery) {
      throw new Error('installed package association evidence lacks native delivery');
    }
  }
  return {
    association,
    primaryPid,
    deliveries,
    duplicateCoalesced: true,
    secondaryForwarded: deliveries.some((event) => event.source === 'secondary_instance'),
  };
}

function validateFocus(events, primaryPid, deliveries) {
  const requested = events.filter((event) => event.type === 'focus_requested');
  const observed = events.filter((event) => event.type === 'focus_observed');
  if (requested.length === 0 || observed.length !== 1) throw new Error('focus lifecycle evidence is incomplete');
  if (requested.some((event) => event.step === 'cli-secondary-duplicate')) {
    throw new Error('coalesced duplicate must not activate or request focus');
  }
  const observation = observed[0];
  const request = requested.find((event) => (
    event.intentId === observation.intentId && event.step === observation.step
  ));
  if (!request || observation.seq <= request.seq
    || !deliveries.some((event) => (
      event.outcome === 'enqueued'
        && event.intentId === request.intentId
        && event.step === request.step
    ))
    || observation.pid !== primaryPid
    || observation.method !== 'platform-active-window-pid') {
    throw new Error('focus observation does not match a prior focus request');
  }
  return { activeWindowFocus: true };
}

function requireDelta(event) {
  const delta = requireRecord(event.authorizationDelta, `${event.type} authorization delta`);
  if (!Number.isSafeInteger(delta.generationBefore) || !Number.isSafeInteger(delta.generationAfter)) {
    throw new Error(`${event.type} authorization generation is invalid`);
  }
  for (const field of ['pendingFileBefore', 'pendingFileAfter', 'pendingWorkspaceBefore', 'pendingWorkspaceAfter']) {
    if (!Number.isSafeInteger(delta[field]) || delta[field] < 0) throw new Error(`${event.type} ${field} is invalid`);
  }
  if (!Array.isArray(delta.added) || !Array.isArray(delta.removed)) {
    throw new Error(`${event.type} authorization grant delta is invalid`);
  }
  return delta;
}

function grantMatches(grant, kind, target, origin) {
  return grant?.kind === kind && grant.path === target && grant.origin === origin && grant.status === 'active';
}

function validateSettlementAuthorization(settlement, targetKind) {
  const delta = requireDelta(settlement);
  if (targetKind === 'file') {
    const parent = path.dirname(settlement.target);
    if (delta.added.length !== 2
      || !delta.added.some((item) => grantMatches(item, 'exact_rw', settlement.target, 'open_document'))
      || !delta.added.some((item) => grantMatches(item, 'internal_asset', parent, 'open_document'))) {
      throw new Error('file settlement authorization delta is not exact');
    }
  } else if (delta.added.length !== 2
    || !delta.added.some((item) => grantMatches(item, 'directory_read', settlement.target, 'workspace'))
    || !delta.added.some((item) => grantMatches(item, 'internal_asset', settlement.target, 'workspace'))) {
    throw new Error('workspace settlement authorization delta is not exact');
  }
}

function validateDirtyGuard(identity, activated, intentEvents) {
  if (typeof activated.dirty !== 'boolean') throw new Error(`${identity} activation dirty state is invalid`);
  const modals = eventsOfType(intentEvents, 'dirty_modal_opened');
  const decisions = eventsOfType(intentEvents, 'dirty_decision');
  const expectedCount = activated.dirty ? 1 : 0;
  if (modals.length !== expectedCount || decisions.length !== expectedCount) {
    throw new Error(`${identity} dirty guard lifecycle is invalid`);
  }
  if (expectedCount === 0) return { events: [], decision: undefined, observed: false };
  assertOrder(identity, [activated, modals[0], decisions[0]]);
  return { events: [modals[0], decisions[0]], decision: decisions[0].decision, observed: true };
}

function validatePreparedReceipts(identity, prepared, settlements, sessionRestore, platform) {
  if (sessionRestore) {
    const kinds = prepared.map((event) => event.receiptKind);
    if (prepared.length === 1 && kinds[0] === 'none') {
      if (settlements.length !== 0 || 'receiptDigest' in prepared[0]) {
        throw new Error(`${identity} zero-receipt restore published receipt metadata`);
      }
      return { receiptCount: 0 };
    }
    const validKinds = (kinds.length === 1 && kinds[0] === 'workspace')
      || (kinds.length === 2 && kinds[0] === 'workspace' && kinds[1] === 'file');
    if (!validKinds) {
      throw new Error(`${identity} session restore receipt set is invalid`);
    }
  } else if (prepared.length !== 1 || settlements.length !== 1) {
    throw new Error(`${identity} native receipt lifecycle is incomplete`);
  }

  const preparedByDigest = new Map();
  for (const event of prepared) {
    if (!/^[0-9a-f]{64}$/.test(event.receiptDigest ?? '') || preparedByDigest.has(event.receiptDigest)) {
      throw new Error(`${identity} prepared receipt digest is invalid or duplicated`);
    }
    preparedByDigest.set(event.receiptDigest, event);
  }
  if (settlements.length !== prepared.length) {
    throw new Error(`${identity} session restore receipt lifecycle is incomplete`);
  }
  const settledDigests = new Set();
  for (const settlement of settlements) {
    const preparedEvent = preparedByDigest.get(settlement.receiptDigest);
    const expectedSettlement = settlement.receiptKind === 'workspace' ? 'applied' : 'committed';
    if (!preparedEvent || settledDigests.has(settlement.receiptDigest)
      || settlement.receiptKind !== preparedEvent.receiptKind
      || !sameEvidenceTarget(settlement.target, preparedEvent.target, platform)
      || settlement.settlement !== expectedSettlement) {
      throw new Error(`${identity} receipt settlement does not match its preparation`);
    }
    settledDigests.add(settlement.receiptDigest);
  }
  if (sessionRestore && prepared.length === 2
    && !evidenceTargetIsStrictDescendant(prepared[1].target, prepared[0].target, platform)) {
    throw new Error(`${identity} restored file is outside its workspace`);
  }
  return { receiptCount: prepared.length };
}

function evidenceTargetIsStrictDescendant(target, root, platform) {
  if (typeof target !== 'string' || typeof root !== 'string') return false;
  if (platform === 'windows') {
    const normalizedTarget = normalizeWindowsEvidenceTarget(target);
    const normalizedRoot = normalizeWindowsEvidenceTarget(root);
    return normalizedTarget !== null && normalizedRoot !== null
      && normalizedTarget.startsWith(`${normalizedRoot}\\`);
  }
  if (!path.posix.isAbsolute(target) || !path.posix.isAbsolute(root)
    || path.posix.normalize(target) !== target || path.posix.normalize(root) !== root) {
    return false;
  }
  const prefix = root === '/' ? '/' : `${root}/`;
  return target !== root && target.startsWith(prefix);
}

function sessionRestoreTargetMatches(reobserved, prepared, platform) {
  if (prepared.length === 1 && prepared[0].receiptKind === 'none') {
    return reobserved.target === 'session_restore';
  }
  return sameEvidenceTarget(reobserved.target, prepared[0]?.target, platform);
}

function validateIntentLifecycle(start, events, platform) {
  const identity = `${start.intentId}/${start.step}`;
  const sessionRestore = start.type === 'session_restore_queued';
  const intentEvents = events.filter((event) => (
    event.intentId === start.intentId && LIFECYCLE_TYPES.has(event.type)
  ));
  if (intentEvents.some((event) => event.step !== start.step)) {
    throw new Error(`${identity} lifecycle step mismatch`);
  }
  const activated = exactlyOne(intentEvents, 'app_activated', identity);
  const settled = exactlyOne(intentEvents, 'app_settled', identity);
  if (activated.seq <= start.seq) throw new Error(`${identity} activated before native delivery`);
  const dirty = validateDirtyGuard(identity, activated, intentEvents);
  const prefix = [activated, ...dirty.events];

  if (settled.status === 'cancelled') {
    if (!sessionRestore || dirty.decision !== 'cancel'
      || intentEvents.some((event) => [
        'backend_reobserved', 'backend_prepared', 'backend_rejected',
        'backend_receipt_settled', 'app_applied',
      ].includes(event.type))) {
      throw new Error(`${identity} cancelled lifecycle is invalid`);
    }
    assertOrder(identity, [...prefix, settled]);
    return {
      kind: 'cancelled', dirtyGuard: true, activationSeq: activated.seq, terminalSeq: settled.seq,
    };
  }
  if (dirty.observed && !['discard', 'switch_without_saving', 'save'].includes(dirty.decision)) {
    throw new Error(`${identity} dirty decision is invalid`);
  }

  const rejected = eventsOfType(intentEvents, 'backend_rejected');
  if (rejected.length > 0) {
    if (rejected.length !== 1
      || eventsOfType(intentEvents, 'backend_reobserved').length !== 0
      || eventsOfType(intentEvents, 'backend_prepared').length !== 0
      || eventsOfType(intentEvents, 'backend_receipt_settled').length !== 0
      || eventsOfType(intentEvents, 'app_applied').length !== 0) {
      throw new Error(`${identity} rejected lifecycle contains contradictory events`);
    }
    if (!sameEvidenceTarget(rejected[0].target, start.target, platform)
      || requireDelta(rejected[0]).added.length !== 0) {
      throw new Error(`${identity} rejected target or authorization delta is invalid`);
    }
    assertOrder(identity, [...prefix, rejected[0], settled]);
    if (settled.status !== 'failed') throw new Error(`${identity} rejection did not settle as failed`);
    return {
      kind: 'rejected',
      rejection: rejected[0],
      dirtyGuard: dirty.observed,
      activationSeq: activated.seq,
      terminalSeq: settled.seq,
      authorizationProducers: [[rejected[0]]],
    };
  }

  const reobserved = exactlyOne(intentEvents, 'backend_reobserved', identity);
  const prepared = eventsOfType(intentEvents, 'backend_prepared');
  const receiptSettlements = eventsOfType(intentEvents, 'backend_receipt_settled');
  const applied = exactlyOne(intentEvents, 'app_applied', identity);
  const expectedTarget = start.target ?? reobserved.target;
  if ((sessionRestore && reobserved.targetKind !== 'session_restore')
    || (!sessionRestore && reobserved.targetKind === 'session_restore')
    || applied.status !== 'accepted'
    || applied.targetKind !== reobserved.targetKind
    || settled.status !== 'accepted') {
    throw new Error(`${identity} applied lifecycle binding is invalid`);
  }
  const expectedReceiptKind = reobserved.targetKind === 'directory' ? 'workspace' : 'file';
  if (!sessionRestore && (prepared[0]?.receiptKind !== expectedReceiptKind
    || !sameEvidenceTarget(receiptSettlements[0]?.target, expectedTarget, platform))) {
    throw new Error(`${identity} applied lifecycle binding is invalid`);
  }
  const receiptFacts = validatePreparedReceipts(
    identity, prepared, receiptSettlements, sessionRestore, platform,
  );
  const targetMatches = sessionRestore
    ? sessionRestoreTargetMatches(reobserved, prepared, platform)
    : sameEvidenceTarget(reobserved.target, expectedTarget, platform);
  if (!targetMatches) throw new Error(`${identity} applied lifecycle binding is invalid`);
  assertOrder(identity, [...prefix, reobserved, ...prepared, ...receiptSettlements, applied, settled]);
  return {
    kind: 'applied',
    targetKind: reobserved.targetKind,
    dirtyGuard: dirty.observed,
    activationSeq: activated.seq,
    terminalSeq: settled.seq,
    receiptCount: receiptFacts.receiptCount,
    authorizationProducers: [prepared, ...receiptSettlements.map((event) => [event])],
  };
}

function validateCausalLifecycles(events, deliveries, platform) {
  const starts = [
    ...deliveries.filter((event) => event.outcome === 'enqueued'),
    ...events.filter((event) => event.type === 'session_restore_queued'),
  ].sort((left, right) => left.seq - right.seq);
  const intentIds = new Set();
  const facts = [];
  for (const start of starts) {
    if (intentIds.has(start.intentId)) throw new Error(`duplicate enqueued intent ${start.intentId}`);
    intentIds.add(start.intentId);
    facts.push({ start, ...validateIntentLifecycle(start, events, platform) });
  }
  if (events.some((event) => (
    LIFECYCLE_TYPES.has(event.type) && !intentIds.has(event.intentId)
  ))) {
    throw new Error('application lifecycle event is not bound to a queued intent');
  }
  return facts;
}

function validateApplyReobserve(challenge, lifecycleFacts) {
  const unicode = lifecycleFacts.find(({ start }) => start.step === 'cli-secondary-unicode');
  const stale = lifecycleFacts.find(({ start }) => start.step === 'cli-stale');
  if (unicode?.kind !== 'rejected'
    || !sameEvidenceTarget(unicode.rejection.target, challenge.scenario.paths.unicodeFile, challenge.platform)) {
    throw new Error('renamed Unicode target was not rejected separately');
  }
  if (stale?.kind !== 'rejected'
    || !sameEvidenceTarget(stale.rejection.target, challenge.scenario.paths.staleFile, challenge.platform)) {
    throw new Error('stale target was not rejected separately');
  }
  const appliedFile = lifecycleFacts.some((fact) => fact.kind === 'applied' && fact.targetKind === 'file');
  const appliedWorkspace = lifecycleFacts.some((fact) => fact.kind === 'applied' && fact.targetKind === 'directory');
  const dirtyGuard = lifecycleFacts.some((fact) => fact.dirtyGuard);
  if (!appliedFile || !appliedWorkspace) throw new Error('real application did not apply both file and workspace state');
  if (!dirtyGuard) throw new Error('apply-reobserve dirty guard evidence is incomplete');
  return { appliedFile, appliedWorkspace, dirtyGuard, exactAuthorization: true };
}

function validateFifo(lifecycleFacts) {
  for (let index = 1; index < lifecycleFacts.length; index += 1) {
    if (lifecycleFacts[index - 1].terminalSeq >= lifecycleFacts[index].activationSeq) {
      throw new Error('prior intent was not terminal before the next activation');
    }
  }
  return true;
}

function validateRestoreCancel(lifecycleFacts) {
  const restoreIndex = lifecycleFacts.findIndex(({ start }) => start.type === 'session_restore_queued');
  const restore = lifecycleFacts[restoreIndex];
  if (restore?.kind !== 'cancelled' || !restore.dirtyGuard) {
    throw new Error('restore-cancel lifecycle evidence is incomplete');
  }
  if (restoreIndex === lifecycleFacts.length - 1) {
    throw new Error('queue did not continue after cancelled session restore');
  }
  return { sessionRestoreCancellation: true, dirtyGuard: true };
}

function authorizationState(delta, suffix) {
  return {
    generation: delta[`generation${suffix}`],
    pendingFile: delta[`pendingFile${suffix}`],
    pendingWorkspace: delta[`pendingWorkspace${suffix}`],
  };
}

function sameAuthorizationState(left, right) {
  return left.generation === right.generation
    && left.pendingFile === right.pendingFile
    && left.pendingWorkspace === right.pendingWorkspace;
}

function authorizationGrantKey(item) {
  return [item.kind, item.path, item.origin, item.status].join('\0');
}

function authorizationGrantSignature(item) {
  return `${authorizationGrantKey(item)}\0${item.count}`;
}

function validateAuthorizationGrant(item, description) {
  const grant = requireRecord(item, description);
  if (!['exact_rw', 'directory_read', 'internal_asset'].includes(grant.kind)
    || typeof grant.path !== 'string' || grant.path.length === 0
    || !['open_document', 'workspace'].includes(grant.origin)
    || !['active', 'suspended'].includes(grant.status)
    || !Number.isSafeInteger(grant.count) || grant.count <= 0) {
    throw new Error(`${description} is invalid`);
  }
  return grant;
}

function applyGrantDelta(ledger, delta, description) {
  const removedGrants = new Map();
  for (const item of delta.removed) {
    const grant = validateAuthorizationGrant(item, `${description} removed grant`);
    const key = authorizationGrantKey(grant);
    if (removedGrants.has(key)
      || authorizationGrantSignature(ledger.get(key) ?? {}) !== authorizationGrantSignature(grant)) {
      throw new Error(`${description} removed grant is not present in producer state`);
    }
    removedGrants.set(key, grant);
    ledger.delete(key);
  }
  const addedKeys = new Set();
  for (const item of delta.added) {
    const grant = validateAuthorizationGrant(item, `${description} added grant`);
    const key = authorizationGrantKey(grant);
    if (addedKeys.has(key) || ledger.has(key)) {
      throw new Error(`${description} added grant already exists in producer state`);
    }
    const removed = removedGrants.get(key);
    if (!removed && grant.count !== 1) {
      throw new Error(`${description} new grant count must be 1`);
    }
    if (removed && grant.count !== removed.count + 1) {
      throw new Error(`${description} aggregate grant count must increment by 1`);
    }
    addedKeys.add(key);
    ledger.set(key, grant);
  }
  for (const key of removedGrants.keys()) {
    if (!addedKeys.has(key)) {
      throw new Error(`${description} removed grant must be re-added by the same transition`);
    }
  }
}

function validateProducerTransition(group, before, ledger) {
  const event = group[0];
  const description = `${event.intentId}/${event.step} ${event.type}`;
  const delta = requireDelta(event);
  if (group.some((item) => JSON.stringify(requireDelta(item)) !== JSON.stringify(delta))) {
    throw new Error(`${description} grouped producer deltas do not match`);
  }
  const eventBefore = authorizationState(delta, 'Before');
  const eventAfter = authorizationState(delta, 'After');
  if (!sameAuthorizationState(before, eventBefore)) {
    throw new Error('authorization producer state is discontinuous');
  }

  const expected = { ...eventBefore };
  if (event.type === 'backend_prepared') {
    for (const prepared of group) {
      if (prepared.receiptKind === 'file') expected.pendingFile += 1;
      else if (prepared.receiptKind === 'workspace') expected.pendingWorkspace += 1;
      else if (prepared.receiptKind !== 'none') throw new Error(`${description} receipt kind is invalid`);
    }
    if (delta.added.length !== 0 || delta.removed.length !== 0) {
      throw new Error(`${description} prepared authorization grants prematurely`);
    }
  } else if (event.type === 'backend_receipt_settled') {
    if (event.receiptKind === 'file') {
      expected.pendingFile -= 1;
      if (eventAfter.pendingFile !== expected.pendingFile) {
        throw new Error('file receipt pending transition is invalid');
      }
    } else if (event.receiptKind === 'workspace') {
      expected.pendingWorkspace -= 1;
      if (eventAfter.pendingWorkspace !== expected.pendingWorkspace) {
        throw new Error('workspace receipt pending transition is invalid');
      }
    }
    if (expected.pendingFile < 0 || expected.pendingWorkspace < 0) {
      throw new Error(`${description} settled a receipt that was not pending`);
    }
    if (eventAfter.generation <= eventBefore.generation) {
      throw new Error(`${description} did not advance authorization generation`);
    }
    validateSettlementAuthorization(event, event.receiptKind === 'file' ? 'file' : 'directory');
    expected.generation = eventAfter.generation;
  }

  if (event.type === 'backend_rejected') {
    if (delta.added.length !== 0 || delta.removed.length !== 0) {
      throw new Error(`${description} rejection changed authorization grants`);
    }
  }
  if (event.type !== 'backend_receipt_settled') expected.generation = eventBefore.generation;
  if (!sameAuthorizationState(expected, eventAfter)) {
    throw new Error(`${description} authorization transition is invalid`);
  }
  applyGrantDelta(ledger, delta, description);
  return eventAfter;
}

function sortedGrantSignatures(grants) {
  return [...grants].map(authorizationGrantSignature).sort();
}

function validateFinalAuthorizationBindings(receipt, lifecycleFacts, finalGrants, platform) {
  const app = requireRecord(receipt.final.app, 'final app evidence');
  if (app.activeFile !== null
    && !finalGrants.some((item) => (
      item.kind === 'exact_rw'
        && item.origin === 'open_document'
        && item.status === 'active'
        && sameEvidenceTarget(item.path, app.activeFile, platform)
    ))) {
    throw new Error('final active file lacks authorization');
  }
  if (app.workspaceRoot !== null
    && !finalGrants.some((item) => (
      item.kind === 'directory_read'
        && item.origin === 'workspace'
        && item.status === 'active'
        && sameEvidenceTarget(item.path, app.workspaceRoot, platform)
    ))) {
    throw new Error('final workspace root lacks authorization');
  }

  const rejectedTargets = lifecycleFacts
    .filter((fact) => fact.kind === 'rejected')
    .map((fact) => fact.rejection.target);
  if (finalGrants.some((item) => (
    item.status === 'active'
      && rejectedTargets.some((target) => sameEvidenceTarget(item.path, target, platform))
  ))) {
    throw new Error('rejected target retains final authorization');
  }
}

function validateAuthorizationEvidence(receipt, lifecycleFacts, platform) {
  const groups = lifecycleFacts
    .flatMap((fact) => fact.authorizationProducers ?? [])
    .sort((left, right) => left[0].seq - right[0].seq);
  const producerEventCount = receipt.events.filter((event) => [
    'backend_prepared', 'backend_rejected', 'backend_receipt_settled',
  ].includes(event.type)).length;
  if (groups.reduce((count, group) => count + group.length, 0) !== producerEventCount) {
    throw new Error('authorization producer event is not bound to an intent lifecycle');
  }
  let state = { generation: 0, pendingFile: 0, pendingWorkspace: 0 };
  const ledger = new Map();
  for (const group of groups) state = validateProducerTransition(group, state, ledger);

  const authorization = requireRecord(receipt.final.authorization, 'final authorization evidence');
  const finalState = {
    generation: authorization.generation,
    pendingFile: authorization.pendingFileReceipts,
    pendingWorkspace: authorization.pendingWorkspaceReceipts,
  };
  if (!sameAuthorizationState(state, finalState)) {
    throw new Error('final authorization counters do not match producer transitions');
  }
  const finalGrants = authorization.grants.map((item, index) => (
    validateAuthorizationGrant(item, `final authorization grant ${index + 1}`)
  ));
  if (JSON.stringify(sortedGrantSignatures(finalGrants))
    !== JSON.stringify(sortedGrantSignatures(ledger.values()))) {
    throw new Error('final authorization grants do not match producer deltas');
  }
  validateFinalAuthorizationBindings(receipt, lifecycleFacts, finalGrants, platform);
  return groups.some((group) => group[0].type === 'backend_receipt_settled');
}

function validateFinal(receipt) {
  const final = requireRecord(receipt.final, 'final evidence');
  const app = requireRecord(final.app, 'final app evidence');
  const authorization = requireRecord(final.authorization, 'final authorization evidence');
  const spellcheck = requireRecord(final.spellcheck, 'final spellcheck evidence');
  if (final.queueEmpty !== true) throw new Error('final open-intent queue is not empty');
  if (app.authorityStatus !== 'committed'
    || typeof app.dirty !== 'boolean'
    || !('activeFile' in app)
    || !('workspaceRoot' in app)
    || !('workspaceToken' in app)) {
    throw new Error('final app state is invalid');
  }
  if (!Number.isSafeInteger(authorization.generation)
    || authorization.pendingFileReceipts !== 0
    || authorization.pendingWorkspaceReceipts !== 0
    || !Array.isArray(authorization.grants)) {
    throw new Error('final authorization state is invalid');
  }
  if (spellcheck.realEditorCount !== 1
    || spellcheck.enabledRealEditorCount !== 1
    || spellcheck.enabledNonEditorCount !== 0
    || spellcheck.dictionaryConsistency !== 'not_claimed') {
    throw new Error('real-WebView spellcheck smoke evidence is invalid');
  }
}

async function validateFixtureState(challenge) {
  for (const name of ['primaryFile', 'associationFile']) {
    const info = await stat(challenge.scenario.paths[name]);
    if (!info.isFile()) throw new Error(`${name} fixture is no longer a regular file`);
  }
  if (!(await stat(challenge.scenario.paths.workspaceDirectory)).isDirectory()) {
    throw new Error('workspace fixture is no longer a directory');
  }
  try {
    await stat(challenge.scenario.paths.staleFile);
    throw new Error('stale fixture unexpectedly exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (challenge.profile === 'apply-reobserve') {
    try {
      await stat(challenge.scenario.paths.unicodeFile);
      throw new Error('original Unicode fixture unexpectedly exists after rename');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const renamedUnicode = await lstat(challenge.scenario.paths.renamedUnicodeFile);
    if (!renamedUnicode.isFile() || renamedUnicode.isSymbolicLink()) {
      throw new Error('renamed Unicode fixture is not a regular file');
    }
  }
}

async function verify(arguments_) {
  const values = parse(arguments_);
  const challenge = JSON.parse(await readFile(one(values, 'challenge'), 'utf8'));
  const receipt = JSON.parse(await readFile(one(values, 'receipt'), 'utf8'));
  const output = one(values, 'output');
  if (challenge.schema !== SCHEMA || challenge.gate !== GATE || !PROFILES.has(challenge.profile)) {
    throw new Error('challenge schema is invalid');
  }
  validateVariantPlatform(challenge.packageVariant, challenge.platform);
  const expectedRoot = path.join(await realpath(os.tmpdir()), 'mmd-packaged-native-open-e2e', challenge.nonce);
  if (!/^[0-9a-f]{64}$/.test(challenge.nonce) || challenge.root !== expectedRoot) {
    throw new Error('challenge root is invalid');
  }
  requireExactIdentity(receipt, challenge);
  const events = validateEvents(receipt);
  const nativeFacts = validateNativeDelivery(receipt, challenge, events);
  const focusFacts = validateFocus(events, nativeFacts.primaryPid, nativeFacts.deliveries);
  const lifecycleFacts = validateCausalLifecycles(events, nativeFacts.deliveries, challenge.platform);
  const profileFacts = challenge.profile === 'apply-reobserve'
    ? validateApplyReobserve(challenge, lifecycleFacts)
    : validateRestoreCancel(lifecycleFacts);
  const fifoQueue = validateFifo(lifecycleFacts);
  validateFinal(receipt);
  const exactAuthorization = validateAuthorizationEvidence(receipt, lifecycleFacts, challenge.platform);
  await validateFixtureState(challenge);
  await writeJsonAtomic(output, {
    ...receipt,
    scope: {
      packagedNativeDelivery: nativeFacts.deliveries.length > 0,
      cliOpen: lifecycleFacts.some((fact) => fact.kind === 'applied'),
      secondaryInstanceForwarding: nativeFacts.secondaryForwarded,
      duplicateCoalescing: nativeFacts.duplicateCoalesced,
      fifoQueue,
      nativeAssociation: nativeFacts.association.status === 'verified',
      activeWindowFocus: focusFacts.activeWindowFocus,
      dirtyGuard: profileFacts.dirtyGuard,
      exactAuthorization,
      sessionRestoreCancellation: profileFacts.sessionRestoreCancellation ?? false,
      realWebviewSpellcheckAttribute: true,
    },
    limitations: [
      ...(nativeFacts.association.status === 'not_applicable' ? [{
        code: nativeFacts.association.reason,
        scope: 'native-file-association',
        packageVariant: challenge.packageVariant,
      }] : []),
      { code: 'dictionary-consistency-not-claimed', scope: 'webview-spellcheck' },
    ],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const operation = process.argv[2];
  const arguments_ = process.argv.slice(3);
  try {
    if (operation === 'issue') await issue(arguments_);
    else if (operation === 'verify') await verify(arguments_);
    else throw new Error('usage: packaged-open-evidence.mjs issue|verify [options]');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
