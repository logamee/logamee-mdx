import { useCallback } from 'react';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import type { EditorPopoutChannelRefs } from './editorPopoutChannelTypes';

interface EditorPopoutOpenerDeps {
  documentEpoch: number | null;
  documentId: string | null;
  editorPopoutOpen: boolean;
  openPanePopout: (pane: 'editor', instanceId?: string) => Promise<{ status: string }>;
  refs: EditorPopoutChannelRefs;
  requestEditorPopoutReady: () => void;
}

export function useEditorPopoutOpener(deps: EditorPopoutOpenerDeps) {
  const { refs } = deps;
  const { documentEpoch, documentId, editorPopoutOpen, openPanePopout, requestEditorPopoutReady } = deps;
  return useCallback(() => {
    if (editorPopoutOpen) {
      focusExistingEditorPopout({ documentEpoch, documentId, editorPopoutOpen, openPanePopout, refs, requestEditorPopoutReady }, refs);
      return;
    }
    if (refs.editorPopoutOpenRequestRef.current) return;
    const instanceId = createPaneProtocolId('markdown-media-popout');
    refs.expectedEditorPopoutInstanceIdRef.current = instanceId;
    refs.pendingEditorPopoutReadyRequestIdRef.current = null;
    refs.editorPopoutOpenRequestRef.current = openSpeculativeEditorPopout(
      { documentEpoch, documentId, editorPopoutOpen, openPanePopout, refs, requestEditorPopoutReady }, refs, instanceId);
  }, [documentEpoch, documentId, editorPopoutOpen, openPanePopout, refs, requestEditorPopoutReady]);
}

function focusExistingEditorPopout(
  deps: Parameters<typeof useEditorPopoutOpener>[0],
  refs: EditorPopoutChannelRefs,
): void {
  void deps.openPanePopout('editor').then((outcome) => {
    if (outcome.status !== 'existing') return;
    const ready = refs.editorPopoutReadyRef.current;
    const expectedInstanceId = refs.expectedEditorPopoutInstanceIdRef.current;
    if (
      ready?.documentId === deps.documentId
      && ready.documentEpoch === deps.documentEpoch
    ) return;
    if (expectedInstanceId || refs.pendingEditorPopoutReadyRequestIdRef.current) return;
    deps.requestEditorPopoutReady();
  });
}

function openSpeculativeEditorPopout(
  deps: Parameters<typeof useEditorPopoutOpener>[0],
  refs: EditorPopoutChannelRefs,
  instanceId: string,
): Promise<void> {
  const openPromise = deps.openPanePopout('editor', instanceId).then((outcome) => {
    if (refs.expectedEditorPopoutInstanceIdRef.current !== instanceId) return;
    if (outcome.status !== 'failed') refs.editorPopoutOpenRef.current = true;
    if (outcome.status === 'existing') {
      // An existing popout owns its URL-derived instance ID, not this speculative one.
      refs.expectedEditorPopoutInstanceIdRef.current = null;
      const ready = refs.editorPopoutReadyRef.current;
      if (ready?.documentId === deps.documentId && ready.documentEpoch === deps.documentEpoch) {
        refs.expectedEditorPopoutInstanceIdRef.current = ready.popoutInstanceId;
        refs.startEditorPopoutHandshakeRef.current?.(ready);
      } else {
        deps.requestEditorPopoutReady();
      }
    } else if (outcome.status === 'failed') {
      refs.expectedEditorPopoutInstanceIdRef.current = null;
      refs.editorPopoutOpenRef.current = false;
    }
  }).finally(() => {
    if (refs.editorPopoutOpenRequestRef.current === openPromise) {
      refs.editorPopoutOpenRequestRef.current = null;
    }
  });
  return openPromise;
}
