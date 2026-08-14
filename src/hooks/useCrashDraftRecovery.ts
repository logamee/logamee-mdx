import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  decodeCrashDraftCatalog,
  decodeCrashDraftDiscardResponse,
  decodeCrashDraftRecoverResponse,
  decodeCrashDraftResetResponse,
  decodeCrashDraftOverflowResetProgress,
  projectCrashDraftError,
  type CrashDraftCatalog,
  type CrashDraftCatalogEntry,
  type CrashDraftRecoverResponse,
  type CrashDraftOverflowResetProgress,
  type ProjectedCrashDraftError,
  type RecoverableCrashDraftEntry,
} from '../lib/crashDrafts';

export interface CrashDraftRecoveryCommands {
  list(): Promise<unknown>;
  recover(documentId: string, expectedEntryToken: string): Promise<unknown>;
  discard(documentId: string, expectedEntryToken: string): Promise<unknown>;
  reset(expectedCatalogToken: string): Promise<unknown>;
  resetOverflowBatch?(expectedRepairReceipt: string): Promise<unknown>;
}

interface CrashDraftRecoveryDependencies {
  enabled?: boolean;
  commands: CrashDraftRecoveryCommands;
  onRecoverDraft: (draft: CrashDraftRecoverResponse) => Promise<void> | void;
  seedRevision?: (documentId: string, revision: number, entryToken: string) => void;
  getStoredEntryToken?: (documentId: string) => string | null;
  confirmDiscarded?: (documentId: string, expectedEntryToken: string) => void;
}

function statusError(status: 'conflict' | 'indeterminate'): ProjectedCrashDraftError {
  return projectCrashDraftError({
    code: status === 'conflict' ? 'revisionConflict' : 'indeterminate',
    canReset: status === 'indeterminate',
  });
}

export function useCrashDraftRecovery({
  enabled = true,
  commands,
  onRecoverDraft,
  seedRevision,
  getStoredEntryToken,
  confirmDiscarded,
}: CrashDraftRecoveryDependencies) {
  const [catalog, setCatalog] = useState<CrashDraftCatalog | null>(null);
  const [busy, setBusy] = useState(enabled);
  const [error, setError] = useState<ProjectedCrashDraftError | null>(null);
  const [overflowRepairReceipt, setOverflowRepairReceipt] = useState<string | null>(null);
  const [overflowRepairProgress, setOverflowRepairProgress] = useState<CrashDraftOverflowResetProgress | null>(null);
  const overflowRepairRef = useRef({ receipt: null as string | null, generation: 0 });
  const seededDocumentsRef = useRef(new Set<string>());
  const recoveredEntriesRef = useRef(new Map<string, RecoverableCrashDraftEntry>());
  const recoveredTokensRef = useRef(new Map<string, string>());

  const replaceOverflowRepairReceipt = useCallback((receipt: string | null) => {
    overflowRepairRef.current = {
      receipt,
      generation: overflowRepairRef.current.generation + 1,
    };
    setOverflowRepairReceipt(receipt);
  }, []);

  const applyCatalog = useCallback((next: CrashDraftCatalog) => {
    if (seedRevision) {
      for (const entry of next.entries) {
        if (entry.status !== 'recoverable' || seededDocumentsRef.current.has(entry.documentId)) continue;
        seedRevision(entry.documentId, entry.draftRevision, entry.entryToken);
        seededDocumentsRef.current.add(entry.documentId);
      }
    }
    setCatalog(next);
  }, [seedRevision]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setBusy(true);
    try {
      applyCatalog(decodeCrashDraftCatalog(await commands.list()));
      replaceOverflowRepairReceipt(null);
      setOverflowRepairProgress(null);
      setError(null);
    } catch (cause) {
      const projected = projectCrashDraftError(cause);
      setCatalog(null);
      replaceOverflowRepairReceipt(projected.repairReceipt ?? null);
      setOverflowRepairProgress(null);
      setError(projected);
    } finally {
      setBusy(false);
    }
  }, [applyCatalog, commands, enabled, replaceOverflowRepairReceipt]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const recover = useCallback(async (entry: RecoverableCrashDraftEntry) => {
    setBusy(true);
    try {
      const draft = decodeCrashDraftRecoverResponse(
        await commands.recover(entry.documentId, entry.entryToken),
      );
      if (
        draft.documentId !== entry.documentId
        || draft.entryToken !== entry.entryToken
        || draft.draftRevision !== entry.draftRevision
      ) throw new Error('Crash draft recovery response did not match request');
      await onRecoverDraft(draft);
      recoveredEntriesRef.current.set(entry.documentId, entry);
      recoveredTokensRef.current.set(entry.documentId, draft.entryToken);
      setCatalog((current) => current && ({
        ...current,
        entries: current.entries.filter((candidate) => candidate.documentId !== entry.documentId),
      }));
      setError(null);
    } catch (cause) {
      setError(projectCrashDraftError(cause));
    } finally {
      setBusy(false);
    }
  }, [commands, onRecoverDraft]);

  const reloadAfterMutation = useCallback(async () => {
    applyCatalog(decodeCrashDraftCatalog(await commands.list()));
  }, [applyCatalog, commands]);

  const discard = useCallback(async (entry: CrashDraftCatalogEntry) => {
    setBusy(true);
    try {
      const response = decodeCrashDraftDiscardResponse(
        await commands.discard(entry.documentId, entry.entryToken),
      );
      if (response.status !== 'confirmedDiscarded') {
        setError(statusError(response.status));
        return;
      }
      recoveredEntriesRef.current.delete(entry.documentId);
      recoveredTokensRef.current.delete(entry.documentId);
      await reloadAfterMutation();
      setError(null);
    } catch (cause) {
      setError(projectCrashDraftError(cause));
    } finally {
      setBusy(false);
    }
  }, [commands, reloadAfterMutation]);

  const discardAll = useCallback(async (expectedCatalogToken: string) => {
    setBusy(true);
    try {
      const response = decodeCrashDraftResetResponse(await commands.reset(expectedCatalogToken));
      if (response.status !== 'confirmedReset') {
        setError(statusError(response.status));
        return;
      }
      recoveredEntriesRef.current.clear();
      recoveredTokensRef.current.clear();
      await reloadAfterMutation();
      setError(null);
    } catch (cause) {
      setError(projectCrashDraftError(cause));
    } finally {
      setBusy(false);
    }
  }, [commands, reloadAfterMutation]);

  const afterConfirmedSave = useCallback(async (documentId: string): Promise<boolean> => {
    const entryToken = recoveredTokensRef.current.get(documentId) ?? getStoredEntryToken?.(documentId);
    if (!entryToken) return true;
    setBusy(true);
    try {
      const response = decodeCrashDraftDiscardResponse(await commands.discard(documentId, entryToken));
      if (response.status !== 'confirmedDiscarded') {
        const recoveredEntry = recoveredEntriesRef.current.get(documentId);
        if (recoveredEntry) {
          setCatalog((current) => current && current.entries.some((entry) => entry.documentId === documentId)
            ? current
            : current && ({ ...current, entries: [...current.entries, recoveredEntry] }));
        }
        setError(statusError(response.status));
        return false;
      }
      recoveredEntriesRef.current.delete(documentId);
      recoveredTokensRef.current.delete(documentId);
      confirmDiscarded?.(documentId, entryToken);
      try {
        await reloadAfterMutation();
        setError(null);
      } catch (cause) {
        setError(projectCrashDraftError(cause));
      }
      return true;
    } catch (cause) {
      const recoveredEntry = recoveredEntriesRef.current.get(documentId);
      if (recoveredEntry) {
        setCatalog((current) => current && current.entries.some((entry) => entry.documentId === documentId)
          ? current
          : current && ({ ...current, entries: [...current.entries, recoveredEntry] }));
      }
      setError(projectCrashDraftError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, [commands, confirmDiscarded, getStoredEntryToken, reloadAfterMutation]);

  const repairOverflowBatch = useCallback(async (): Promise<CrashDraftOverflowResetProgress | null> => {
    const command = commands.resetOverflowBatch;
    const current = overflowRepairRef.current;
    if (!command || !current.receipt) return null;

    const consumedReceipt = current.receipt;
    const consumedGeneration = current.generation + 1;
    overflowRepairRef.current = { receipt: null, generation: consumedGeneration };
    setOverflowRepairReceipt(null);
    setBusy(true);
    try {
      const progress = decodeCrashDraftOverflowResetProgress(await command(consumedReceipt));
      if (
        overflowRepairRef.current.generation !== consumedGeneration
        || overflowRepairRef.current.receipt !== null
      ) return null;
      if (progress.moreWorkRemaining) {
        if (progress.repairReceipt === consumedReceipt) {
          throw new Error('Crash draft overflow repair receipt was replayed');
        }
        replaceOverflowRepairReceipt(progress.repairReceipt);
        setOverflowRepairProgress(progress);
        setError(projectCrashDraftError({
          code: 'storeFull',
          repairReceipt: progress.repairReceipt,
        }));
        return progress;
      }

      setOverflowRepairProgress(progress);
      await refresh();
      setOverflowRepairProgress(progress);
      return progress;
    } catch (cause) {
      if (
        overflowRepairRef.current.generation === consumedGeneration
        && overflowRepairRef.current.receipt === null
      ) {
        setOverflowRepairProgress(null);
        setError(projectCrashDraftError(cause));
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, [commands.resetOverflowBatch, refresh, replaceOverflowRepairReceipt]);

  return useMemo(() => ({
    afterConfirmedSave,
    busy,
    canRepairOverflow: Boolean(overflowRepairReceipt && commands.resetOverflowBatch),
    catalog,
    discard,
    discardAll,
    error,
    overflowRepairProgress,
    repairOverflowBatch,
    recover,
    retry: refresh,
  }), [
    afterConfirmedSave,
    busy,
    catalog,
    commands.resetOverflowBatch,
    discard,
    discardAll,
    error,
    overflowRepairProgress,
    overflowRepairReceipt,
    recover,
    refresh,
    repairOverflowBatch,
  ]);
}
