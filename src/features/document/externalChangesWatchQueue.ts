import type { ActiveDocumentWatchSnapshotEnvelope } from '../../lib/activeDocumentWatch';
import { isEditableFileKind, type DocumentSessionState } from '../../lib/documentSession';
import { reduceExternalDocumentChange } from '../../lib/externalDocumentChange';
import type { AcceptedActiveDocumentWatch } from './sessionTypes';
import { editableFileVersion } from './sessionFacts';
import type { FileVersion } from '../../types';

export type WatchEnvelopeEnqueuer = (
  accepted: import('./sessionTypes').AcceptedActiveDocumentWatch,
  envelope: ActiveDocumentWatchSnapshotEnvelope,
  registration?: boolean,
) => Promise<boolean>;

export interface WatchEnvelopeQueueContext {
  accepted: AcceptedActiveDocumentWatch;
  envelope: ActiveDocumentWatchSnapshotEnvelope;
  registration: boolean;
  activeFileVersionRef: { current: FileVersion | null };
  activePathRef: { current: string | null };
  currentDocumentSessionState: () => DocumentSessionState;
  documentGenerationRef: { current: number };
  paneStateRef: { current: { documentId: string; authorityStatus?: string } };
  applyExternalDocumentDecision: (
    decision: ReturnType<typeof reduceExternalDocumentChange>,
    sequence: number,
  ) => Promise<void>;
  envelopeMatchesAcceptedPath: (
    accepted: AcceptedActiveDocumentWatch,
    envelope: ActiveDocumentWatchSnapshotEnvelope,
  ) => boolean;
  isAcceptedWatchCurrent: (
    accepted: AcceptedActiveDocumentWatch,
    sequence?: number,
  ) => boolean;
}

// 监视信封入队操作：isCurrent 按 registration/常规两种口径校验，apply 归约决策并落盘。
export function watchEnvelopeQueueOperation(ctx: WatchEnvelopeQueueContext) {
  const { accepted, envelope, registration } = ctx;
  return {
    run: async () => envelope,
    isCurrent: () => {
      if (registration) {
        return ctx.documentGenerationRef.current === accepted.documentGeneration
          && ctx.paneStateRef.current.documentId === accepted.documentId
          && (ctx.paneStateRef.current.authorityStatus ?? 'unknown') === 'committed'
          && ctx.activePathRef.current === accepted.path;
      }
      return ctx.isAcceptedWatchCurrent(accepted, envelope.sequence)
        && ctx.envelopeMatchesAcceptedPath(accepted, envelope);
    },
    apply: async (currentEnvelope: ActiveDocumentWatchSnapshotEnvelope) => {
      if (!registration && (!ctx.isAcceptedWatchCurrent(accepted, currentEnvelope.sequence)
        || !ctx.envelopeMatchesAcceptedPath(accepted, currentEnvelope))) {
        return;
      }
      accepted.highestAppliedSequence = Math.max(
        accepted.highestAppliedSequence,
        currentEnvelope.sequence,
      );
      const decision = reduceExternalDocumentChange(ctx.currentDocumentSessionState(), currentEnvelope);
      await ctx.applyExternalDocumentDecision(decision, currentEnvelope.sequence);
      if (decision.kind === 'apply-document'
        && currentEnvelope.snapshot.status === 'present'
        && isEditableFileKind(currentEnvelope.snapshot.file.kind)) {
        ctx.activeFileVersionRef.current = editableFileVersion(currentEnvelope.snapshot.file);
      }
    },
  };
}
