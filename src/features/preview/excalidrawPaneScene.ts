/* eslint-disable react-hooks/exhaustive-deps -- 纯搬移：效果依赖保持提取前原样，由 ExcalidrawPane.test.tsx 回归约束 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import { emitAppFeedbackError } from '../../lib/appFeedback';
import { restoreExcalidrawScene } from '../../lib/excalidrawRuntime';

export interface PreparedExcalidrawScene {
  canonicalContent: string;
  initialData: ReturnType<typeof restoreExcalidrawScene>;
}

export type ExcalidrawChange = NonNullable<ComponentProps<typeof Excalidraw>['onChange']>;

function prepareExcalidrawScene(content: string): PreparedExcalidrawScene {
  const restored = restoreExcalidrawScene(content);
  return {
    canonicalContent: serializeAsJSON(restored.elements, restored.appState, restored.files, 'local'),
    initialData: restored,
  };
}

// 场景实例同步：内容或文档世代变化时重建场景引用并递增重挂键。
export function useSceneInstanceSync(deps: {
  content: string;
  documentToken: string;
  prepared: PreparedExcalidrawScene | null;
}): { sceneContentRef: React.RefObject<{
  appTheme: PreparedExcalidrawScene['initialData']['appState']['theme'] | undefined; canonicalContent: string | null; content: string; documentToken: string;
}>; sceneInstanceRevision: number } {
  const { content, documentToken, prepared } = deps;
  const [sceneInstanceRevision, setSceneInstanceRevision] = useState(0);
  const sceneContentRef = useRef({
    appTheme: prepared?.initialData.appState.theme,
    canonicalContent: prepared?.canonicalContent ?? null,
    content,
    documentToken,
  });

  useEffect(() => {
    const current = sceneContentRef.current;
    if (current.documentToken !== documentToken) {
      sceneContentRef.current = {
        appTheme: prepared?.initialData.appState.theme,
        canonicalContent: prepared?.canonicalContent ?? null,
        content,
        documentToken,
      };
      return;
    }
    if (current.content === content) return;

    // Excalidraw consumes initialData only on mount. A synchronized or externally
    // reloaded scene must remount so that its element and binary-file sets agree.
    sceneContentRef.current = {
      appTheme: prepared?.initialData.appState.theme,
      canonicalContent: prepared?.canonicalContent ?? null,
      content,
      documentToken,
    };
    setSceneInstanceRevision((revision) => revision + 1);
  }, [
    content,
    documentToken,
    prepared?.canonicalContent,
    prepared?.initialData.appState.theme,
  ]);

  return { sceneContentRef, sceneInstanceRevision };
}

// 无效场景上报：同一错误令牌只上报一次；无回调时走全局反馈。
export function useInvalidSceneReporting(deps: {
  content: string;
  documentToken: string;
  onInvalidScene?: (message: string) => void;
  prepared: PreparedExcalidrawScene | null;
}): void {
  const { content, documentToken, prepared } = deps;
  const onInvalidSceneRef = useRef(deps.onInvalidScene);
  onInvalidSceneRef.current = deps.onInvalidScene;
  const reportedInvalidSceneRef = useRef<string | null>(null);

  useEffect(() => {
    if (prepared) {
      reportedInvalidSceneRef.current = null;
      return;
    }
    const errorToken = `${documentToken}:${content}`;
    if (reportedInvalidSceneRef.current === errorToken) return;
    reportedInvalidSceneRef.current = errorToken;
    if (onInvalidSceneRef.current) onInvalidSceneRef.current('Invalid Excalidraw scene');
    else emitAppFeedbackError('Invalid Excalidraw scene');
  }, [content, documentToken, prepared]);
}

// 变更处理器：保留挂载时主题，序列化后仅在偏离基准时上报。
export function useSceneChangeHandler(sceneContentRef: {
  current: {
    appTheme: PreparedExcalidrawScene['initialData']['appState']['theme'] | undefined;
    canonicalContent: string | null;
    content: string;
    documentToken: string;
  };
}, onContentChange: (content: string) => void): ExcalidrawChange {
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  return useCallback<ExcalidrawChange>((elements, appState, files) => {
    const normalizedAppState = { ...appState };
    if (sceneContentRef.current.appTheme === undefined) Reflect.deleteProperty(normalizedAppState, 'theme');
    else normalizedAppState.theme = sceneContentRef.current.appTheme;
    const serialized = serializeAsJSON(elements, normalizedAppState, files, 'local');
    if (serialized === sceneContentRef.current.canonicalContent) return;
    sceneContentRef.current = {
      ...sceneContentRef.current,
      canonicalContent: serialized,
      content: serialized,
    };
    onContentChangeRef.current(serialized);
  }, []);
}

// 场景准备：解析失败返回 null，交由无效场景上报处理。
export function usePreparedExcalidrawScene(content: string): PreparedExcalidrawScene | null {
  return useMemo(() => {
    try {
      return prepareExcalidrawScene(content);
    } catch {
      return null;
    }
  }, [content]);
}
