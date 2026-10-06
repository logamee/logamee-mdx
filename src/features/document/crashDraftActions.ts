/* eslint-disable react-hooks/exhaustive-deps -- 子钩子依赖数组保持搬移前原样，由 useCrashDraftRecovery.test.tsx 回归约束 */
import { useCallback } from 'react';
import {
  decodeCrashDraftDiscardResponse,
  decodeCrashDraftRecoverResponse,
  decodeCrashDraftResetResponse,
  decodeCrashDraftCatalog,
  projectCrashDraftError,
  type CrashDraftCatalog,
  type CrashDraftCatalogEntry,
  type ProjectedCrashDraftError,
  type RecoverableCrashDraftEntry,
} from '../../lib/crashDrafts';
import type { CrashDraftRecoveryDependencies } from './crashDraftTypes';

export function statusError(status: 'conflict' | 'indeterminate'): ProjectedCrashDraftError {
  return projectCrashDraftError({
    code: status === 'conflict' ? 'revisionConflict' : 'indeterminate',
    canReset: status === 'indeterminate',
  });
}

async function runCrashDraftAction(deps: {
  commands: CrashDraftRecoveryDependencies['commands'];
  onRecoverDraft: CrashDraftRecoveryDependencies['onRecoverDraft'];
  recoveredEntriesRef: React.RefObject<Map<string, RecoverableCrashDraftEntry>>;
  recoveredTokensRef: React.RefObject<Map<string, string>>;
  setBusy: (busy: boolean) => void;
  setCatalog: React.Dispatch<React.SetStateAction<CrashDraftCatalog | null>>;
  setError: (error: ProjectedCrashDraftError | null) => void;
}, entry: RecoverableCrashDraftEntry): Promise<void> {
  const { setBusy, setCatalog, setError } = deps;
  setBusy(true);
  try {
    const draft = decodeCrashDraftRecoverResponse(
      await deps.commands.recover(entry.documentId, entry.entryToken),
    );
    if (
      draft.documentId !== entry.documentId
      || draft.entryToken !== entry.entryToken
      || draft.draftRevision !== entry.draftRevision
    ) throw new Error('Crash draft recovery response did not match request');
    await deps.onRecoverDraft(draft);
    deps.recoveredEntriesRef.current.set(entry.documentId, entry);
    deps.recoveredTokensRef.current.set(entry.documentId, draft.entryToken);
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
}

async function runCrashDraftDiscard(deps: {
  commands: CrashDraftRecoveryDependencies['commands'];
  recoveredEntriesRef: React.RefObject<Map<string, RecoverableCrashDraftEntry>>;
  recoveredTokensRef: React.RefObject<Map<string, string>>;
  reloadAfterMutation: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setCatalog: React.Dispatch<React.SetStateAction<CrashDraftCatalog | null>>;
  setError: (error: ProjectedCrashDraftError | null) => void;
}, entry: CrashDraftCatalogEntry): Promise<void> {
  const { setBusy, setError } = deps;
  setBusy(true);
  try {
    const response = decodeCrashDraftDiscardResponse(
      await deps.commands.discard(entry.documentId, entry.entryToken),
    );
    if (response.status !== 'confirmedDiscarded') {
      setError(statusError(response.status));
      return;
    }
    deps.recoveredEntriesRef.current.delete(entry.documentId);
    deps.recoveredTokensRef.current.delete(entry.documentId);
    await deps.reloadAfterMutation();
    setError(null);
  } catch (cause) {
    setError(projectCrashDraftError(cause));
  } finally {
    setBusy(false);
  }
}

async function runCrashDraftReset(deps: {
  commands: CrashDraftRecoveryDependencies['commands'];
  recoveredEntriesRef: React.RefObject<Map<string, RecoverableCrashDraftEntry>>;
  recoveredTokensRef: React.RefObject<Map<string, string>>;
  reloadAfterMutation: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setError: (error: ProjectedCrashDraftError | null) => void;
}, expectedCatalogToken: string): Promise<void> {
  const { setBusy, setError } = deps;
  setBusy(true);
  try {
    const response = decodeCrashDraftResetResponse(await deps.commands.reset(expectedCatalogToken));
    if (response.status !== 'confirmedReset') {
      setError(statusError(response.status));
      return;
    }
    deps.recoveredEntriesRef.current.clear();
    deps.recoveredTokensRef.current.clear();
    await deps.reloadAfterMutation();
    setError(null);
  } catch (cause) {
    setError(projectCrashDraftError(cause));
  } finally {
    setBusy(false);
  }
}

export function useCrashDraftMutations(deps: {
  applyCatalog: (next: CrashDraftCatalog) => void;
  commands: CrashDraftRecoveryDependencies['commands'];
  onRecoverDraft: CrashDraftRecoveryDependencies['onRecoverDraft'];
  recoveredEntriesRef: React.RefObject<Map<string, RecoverableCrashDraftEntry>>;
  recoveredTokensRef: React.RefObject<Map<string, string>>;
  setBusy: (busy: boolean) => void;
  setCatalog: React.Dispatch<React.SetStateAction<CrashDraftCatalog | null>>;
  setError: (error: ProjectedCrashDraftError | null) => void;
}) {
  const { applyCatalog, commands, onRecoverDraft, recoveredEntriesRef, recoveredTokensRef, setBusy, setCatalog, setError } = deps;
  const reloadAfterMutation = useCallback(async () => {
    applyCatalog(decodeCrashDraftCatalog(await commands.list()));
  }, [applyCatalog, commands]);
  const recover = useCallback(async (entry: RecoverableCrashDraftEntry) => {
    await runCrashDraftAction({ commands, onRecoverDraft, recoveredEntriesRef, recoveredTokensRef, setBusy, setCatalog, setError }, entry);
  }, [commands, onRecoverDraft]);
  const discard = useCallback(async (entry: CrashDraftCatalogEntry) => {
    await runCrashDraftDiscard({ commands, recoveredEntriesRef, recoveredTokensRef, reloadAfterMutation, setBusy, setCatalog, setError }, entry);
  }, [commands, reloadAfterMutation]);
  const discardAll = useCallback(async (expectedCatalogToken: string) => {
    await runCrashDraftReset({ commands, recoveredEntriesRef, recoveredTokensRef, reloadAfterMutation, setBusy, setError }, expectedCatalogToken);
  }, [commands, reloadAfterMutation]);
  return { discard, discardAll, recover, reloadAfterMutation };
}
