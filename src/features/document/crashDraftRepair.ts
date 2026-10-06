/* eslint-disable react-hooks/exhaustive-deps -- 子钩子依赖数组保持搬移前原样，由 useCrashDraftRecovery.test.tsx 回归约束 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  decodeCrashDraftCatalog,
  decodeCrashDraftDiscardResponse,
  decodeCrashDraftOverflowResetProgress,
  projectCrashDraftError,
  type CrashDraftCatalog,
  type CrashDraftOverflowResetProgress,
  type ProjectedCrashDraftError,
  type RecoverableCrashDraftEntry,
} from '../../lib/crashDrafts';

import type { CrashDraftRecoveryDependencies } from './crashDraftTypes';
import { statusError } from './crashDraftActions';

// 溢出修复批次：消费修复回执并按进度续批或收尾。
export function useCrashDraftOverflowRepair(deps: {
  commands: CrashDraftRecoveryDependencies['commands'];
  refresh: () => Promise<void>;
  replaceOverflowRepairReceipt: (receipt: string | null) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: ProjectedCrashDraftError | null) => void;
  setOverflowRepairProgress: (progress: CrashDraftOverflowResetProgress | null) => void;
  setOverflowRepairReceipt: (receipt: string | null) => void;
  overflowRepairRef: React.RefObject<{ receipt: string | null; generation: number }>;
}): () => Promise<CrashDraftOverflowResetProgress | null> {
  const { commands, overflowRepairRef, refresh, replaceOverflowRepairReceipt, setBusy, setError, setOverflowRepairProgress, setOverflowRepairReceipt } = deps;
  return useCallback(async (): Promise<CrashDraftOverflowResetProgress | null> => {
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
      return await applyOverflowProgress({
        consumedGeneration, consumedReceipt, overflowRepairRef, progress, refresh,
        replaceOverflowRepairReceipt, setError, setOverflowRepairProgress,
      });
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
  }, [commands.resetOverflowBatch, overflowRepairRef, refresh, replaceOverflowRepairReceipt, setBusy, setError, setOverflowRepairProgress, setOverflowRepairReceipt]);
}

// 进度应用：仍有余量时续批；收尾时刷新目录。
async function applyOverflowProgress(args: {
  consumedGeneration: number;
  consumedReceipt: string;
  overflowRepairRef: React.RefObject<{ receipt: string | null; generation: number }>;
  progress: CrashDraftOverflowResetProgress;
  refresh: () => Promise<void>;
  replaceOverflowRepairReceipt: (receipt: string | null) => void;
  setError: (error: ProjectedCrashDraftError | null) => void;
  setOverflowRepairProgress: (progress: CrashDraftOverflowResetProgress | null) => void;
}): Promise<CrashDraftOverflowResetProgress | null> {
  const { overflowRepairRef, progress, refresh, replaceOverflowRepairReceipt, setError, setOverflowRepairProgress } = args;
  if (
    overflowRepairRef.current.generation !== args.consumedGeneration
    || overflowRepairRef.current.receipt !== null
  ) return null;
  if (progress.moreWorkRemaining) {
    if (progress.repairReceipt === args.consumedReceipt) {
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
}

// 丢弃失败时把恢复条目放回目录（避免目录中既无条目又留下登记）。
function restoreRecoveredEntry(
  recoveredEntries: Map<string, RecoverableCrashDraftEntry>,
  setCatalog: React.Dispatch<React.SetStateAction<CrashDraftCatalog | null>>,
  documentId: string,
): void {
  const recoveredEntry = recoveredEntries.get(documentId);
  if (!recoveredEntry) return;
  setCatalog((current) => current && current.entries.some((entry) => entry.documentId === documentId)
    ? current
    : current && ({ ...current, entries: [...current.entries, recoveredEntry] }));
}

// 目录加载：成功应用目录并清空修复状态；失败按投影错误保留回执。
async function runCrashDraftRefresh(deps: {
  applyCatalog: (next: CrashDraftCatalog) => void;
  commands: CrashDraftRecoveryDependencies['commands'];
  enabled: boolean;
  replaceOverflowRepairReceipt: (receipt: string | null) => void;
  setBusy: (busy: boolean) => void;
  setCatalog: React.Dispatch<React.SetStateAction<CrashDraftCatalog | null>>;
  setError: (error: ProjectedCrashDraftError | null) => void;
  setOverflowRepairProgress: (progress: CrashDraftOverflowResetProgress | null) => void;
}): Promise<void> {
  const { applyCatalog, commands, enabled, replaceOverflowRepairReceipt, setBusy, setError, setOverflowRepairProgress } = deps;
  if (!enabled) return;
  setBusy(true);
  try {
    applyCatalog(decodeCrashDraftCatalog(await commands.list()));
    replaceOverflowRepairReceipt(null);
    setOverflowRepairProgress(null);
    setError(null);
  } catch (cause) {
    const projected = projectCrashDraftError(cause);
    deps.setCatalog(null);
    replaceOverflowRepairReceipt(projected.repairReceipt ?? null);
    setOverflowRepairProgress(null);
    setError(projected);
  } finally {
    setBusy(false);
  }
}

// 保存确认后的草稿丢弃：失败时把条目放回目录（若仍缺失）。
export function useCrashDraftPostSaveDiscard(deps: {
  commands: CrashDraftRecoveryDependencies['commands'];
  confirmDiscarded: CrashDraftRecoveryDependencies['confirmDiscarded'];
  getStoredEntryToken: CrashDraftRecoveryDependencies['getStoredEntryToken'];
  reloadAfterMutation: () => Promise<void>;
  recoveredEntriesRef: React.RefObject<Map<string, RecoverableCrashDraftEntry>>;
  recoveredTokensRef: React.RefObject<Map<string, string>>;
  setBusy: (busy: boolean) => void;
  setCatalog: React.Dispatch<React.SetStateAction<CrashDraftCatalog | null>>;
  setError: (error: ProjectedCrashDraftError | null) => void;
}): (documentId: string) => Promise<boolean> {
  const { commands, confirmDiscarded, getStoredEntryToken, reloadAfterMutation } = deps;
  const { recoveredEntriesRef, recoveredTokensRef, setBusy, setCatalog, setError } = deps;
  return useCallback(async (documentId: string): Promise<boolean> => {
    const entryToken = recoveredTokensRef.current.get(documentId) ?? getStoredEntryToken?.(documentId);
    if (!entryToken) return true;
    setBusy(true);
    try {
      const response = decodeCrashDraftDiscardResponse(await commands.discard(documentId, entryToken));
      if (response.status !== 'confirmedDiscarded') {
        restoreRecoveredEntry(recoveredEntriesRef.current, setCatalog, documentId);
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
      restoreRecoveredEntry(recoveredEntriesRef.current, setCatalog, documentId);
      setError(projectCrashDraftError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, [commands, confirmDiscarded, getStoredEntryToken, reloadAfterMutation, recoveredEntriesRef, recoveredTokensRef, setBusy, setCatalog, setError]);
}


// 溢出修复状态束：回执引用、回执值与进度。
export function useOverflowRepairState() {
  const [overflowRepairReceipt, setOverflowRepairReceipt] = useState<string | null>(null);
  const [overflowRepairProgress, setOverflowRepairProgress] = useState<CrashDraftOverflowResetProgress | null>(null);
  const overflowRepairRef = useRef({ receipt: null as string | null, generation: 0 });
  return useMemo(() => ({
    overflowRepairProgress,
    overflowRepairReceipt,
    overflowRepairRef,
    setOverflowRepairProgress,
    setOverflowRepairReceipt,
  }), [overflowRepairProgress, overflowRepairReceipt]);
}

// 草稿变更动作：恢复/丢弃/全部丢弃与目录重载。




// 恢复动作：解码回执须与请求一致，成功后登记令牌并从目录移除该条目。

// 目录状态：应用目录并按需播种 revision，加载/刷新与回执替换。
export function useCrashDraftCatalogState(deps: {
  commands: CrashDraftRecoveryDependencies['commands'];
  enabled: boolean;
  overflow: ReturnType<typeof useOverflowRepairState>;
  seededDocumentsRef: React.RefObject<Set<string>>;
  seedRevision: CrashDraftRecoveryDependencies['seedRevision'];
  setBusy: (busy: boolean) => void;
  setError: (error: ProjectedCrashDraftError | null) => void;
}) {
  const { commands, enabled, overflow, seededDocumentsRef, seedRevision, setBusy, setError } = deps;
  const [catalog, setCatalog] = useState<CrashDraftCatalog | null>(null);

  const replaceOverflowRepairReceipt = useCallback((receipt: string | null) => {
    overflow.overflowRepairRef.current = {
      receipt,
      generation: overflow.overflowRepairRef.current.generation + 1,
    };
    overflow.setOverflowRepairReceipt(receipt);
  }, [overflow.overflowRepairRef, overflow.setOverflowRepairReceipt]);

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

  const refresh = useCallback(
    () => runCrashDraftRefresh({
      applyCatalog, commands, enabled, replaceOverflowRepairReceipt, setBusy,
      setCatalog, setError, setOverflowRepairProgress: overflow.setOverflowRepairProgress,
    }),
    [applyCatalog, commands, enabled, overflow.setOverflowRepairProgress, replaceOverflowRepairReceipt]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return { applyCatalog, catalog, refresh, replaceOverflowRepairReceipt, setCatalog };
}

// 全部丢弃：确认重置令牌后清空全部登记并重载。
