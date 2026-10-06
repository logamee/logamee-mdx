import { useMemo, useRef, useState } from 'react';
import { useCrashDraftMutations } from './crashDraftActions';
import {
  useCrashDraftCatalogState,
  useCrashDraftOverflowRepair,
  useCrashDraftPostSaveDiscard,
  useOverflowRepairState,
} from './crashDraftRepair';
import type { CrashDraftRecoveryDependencies } from './crashDraftTypes';
import type {
  ProjectedCrashDraftError,
  RecoverableCrashDraftEntry,
} from '../../lib/crashDrafts';
export type { CrashDraftRecoveryCommands, CrashDraftRecoveryDependencies } from './crashDraftTypes';


export function useCrashDraftRecovery({
  enabled = true,
  commands,
  onRecoverDraft,
  seedRevision,
  getStoredEntryToken,
  confirmDiscarded,
}: CrashDraftRecoveryDependencies) {
  const [busy, setBusy] = useState(enabled);
  const [error, setError] = useState<ProjectedCrashDraftError | null>(null);
  const overflow = useOverflowRepairState();
  const seededDocumentsRef = useRef(new Set<string>());
  const recoveredEntriesRef = useRef(new Map<string, RecoverableCrashDraftEntry>());
  const recoveredTokensRef = useRef(new Map<string, string>());

  const { applyCatalog, catalog, refresh, replaceOverflowRepairReceipt, setCatalog } = useCrashDraftCatalogState({
    commands, enabled, seededDocumentsRef, seedRevision, overflow, setBusy, setError });
  const { discard, discardAll, recover, reloadAfterMutation } = useCrashDraftMutations({
    applyCatalog, commands, onRecoverDraft, recoveredEntriesRef, recoveredTokensRef, setBusy, setCatalog, setError });
  const afterConfirmedSave = useCrashDraftPostSaveDiscard({
    commands, confirmDiscarded, getStoredEntryToken, reloadAfterMutation, setBusy, setCatalog, setError,
    recoveredEntriesRef, recoveredTokensRef });
  const repairOverflowBatch = useCrashDraftOverflowRepair({
    commands, refresh, replaceOverflowRepairReceipt, setBusy, setError,
    overflowRepairRef: overflow.overflowRepairRef,
    setOverflowRepairProgress: overflow.setOverflowRepairProgress,
    setOverflowRepairReceipt: overflow.setOverflowRepairReceipt });

  return useMemo(() => ({
    afterConfirmedSave, busy,
    canRepairOverflow: Boolean(overflow.overflowRepairReceipt && commands.resetOverflowBatch),
    catalog, discard, discardAll, error,
    overflowRepairProgress: overflow.overflowRepairProgress,
    repairOverflowBatch, recover, retry: refresh,
  }), [
    afterConfirmedSave, busy, catalog, commands.resetOverflowBatch,
    discard, discardAll, error,
    overflow.overflowRepairProgress, overflow.overflowRepairReceipt,
    recover, refresh, repairOverflowBatch,
  ]);
}
