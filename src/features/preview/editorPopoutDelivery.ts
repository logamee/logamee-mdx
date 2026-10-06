import { useCallback } from 'react';
import { normalizeAppError } from '../../lib/appFeedback';
import { createPaneProtocolId } from '../../lib/tauriPaneReplication';
import { getPanePopoutLabel } from '../../lib/paneLayout';
import {
  MARKDOWN_MEDIA_INSERTION_EVENT,
  MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT,
  type MarkdownMediaCursorInsertion } from '../../lib/markdownMedia';
import { emitToWithRetry } from './mediaRetry';
import { cancelMarkdownMediaInsertionHandshake } from './editorPopoutHandshakeProtocol';
import type { EditorPopoutChannelRefs, EditorPopoutMediaChannelDeps } from './editorPopoutChannelTypes';

export function useEditorPopoutInsertionDelivery(deps: {
  deps: EditorPopoutMediaChannelDeps;
  refs: EditorPopoutChannelRefs;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}) {
  const { refs, setError, setNotice } = deps;
  const { locale, mountedRef } = deps.deps;
  return useCallback((insertion: MarkdownMediaCursorInsertion) => {
    const generation = refs.popoutMediaInsertionGenerationRef.current;
    const delivery = refs.popoutMediaInsertionTailRef.current
      .catch(() => undefined)
      .then(() => {
        return emitToWithRetry(
          getPanePopoutLabel('editor'),
          MARKDOWN_MEDIA_INSERTION_EVENT,
          insertion,
          () => generation === refs.popoutMediaInsertionGenerationRef.current
            && refs.editorPopoutOpenRef.current
            && mountedRef.current,
          refs.markdownMediaRetryControllerRef.current,
        );
      });
    refs.popoutMediaInsertionTailRef.current = delivery;
    void delivery.catch((err: unknown) => {
      if (generation !== refs.popoutMediaInsertionGenerationRef.current || !mountedRef.current) return;
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
  }, [locale, mountedRef, refs, setError, setNotice]);
}

export function useEditorPopoutReadyRequest(deps: {
  deps: EditorPopoutMediaChannelDeps;
  refs: EditorPopoutChannelRefs;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}) {
  const { refs, setError, setNotice } = deps;
  const { documentEpoch, documentId, locale, mountedRef } = deps.deps;
  return useCallback(() => {
    if (refs.pendingEditorPopoutReadyRequestIdRef.current) return;
    const readyRequestId = createPaneProtocolId('markdown-media-ready-request');
    refs.pendingEditorPopoutReadyRequestIdRef.current = readyRequestId;
    refs.editorPopoutReadyRef.current = null;
    cancelMarkdownMediaInsertionHandshake(refs.editorPopoutHandshakeRef.current);
    refs.editorPopoutHandshakeRef.current = null;
    refs.editorPopoutOpenRef.current = true;
    void emitToWithRetry(
      getPanePopoutLabel('editor'),
      MARKDOWN_MEDIA_INSERTION_REQUEST_READY_EVENT,
      { documentEpoch, documentId, readyRequestId },
      () => mountedRef.current,
      refs.markdownMediaRetryControllerRef.current,
    ).catch((err: unknown) => {
      if (!mountedRef.current) return;
      setError(normalizeAppError(err, locale));
      setNotice(null);
    });
  }, [documentEpoch, documentId, locale, mountedRef, refs, setError, setNotice]);
}

