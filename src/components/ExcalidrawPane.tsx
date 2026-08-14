import {
  Excalidraw,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
} from 'react';
import { emitAppFeedbackError } from '../lib/appFeedback';
import { displayName } from '../lib/documentNames';
import { restoreExcalidrawScene } from '../lib/excalidrawRuntime';
import type { PanePopoutButtonState } from '../lib/paneLayout';
import { useObservedEffectiveTheme } from '../lib/themeObservation';
import { PaneHeader } from './PaneHeader';
import { useI18n } from '../lib/i18n';

interface ExcalidrawPaneProps {
  activePath: string | null;
  content: string;
  documentEpoch: number;
  documentId: string;
  editable: boolean;
  onContentChange: (content: string) => void;
  onInvalidScene?: (message: string) => void;
  onPopout?: () => void;
  paneRef?: Ref<HTMLElement>;
  popout?: boolean;
  popoutButton?: PanePopoutButtonState;
}

interface PreparedExcalidrawScene {
  canonicalContent: string;
  initialData: ReturnType<typeof restoreExcalidrawScene>;
}

type ExcalidrawChange = NonNullable<ComponentProps<typeof Excalidraw>['onChange']>;

function prepareExcalidrawScene(content: string): PreparedExcalidrawScene {
  const restored = restoreExcalidrawScene(content);

  return {
    canonicalContent: serializeAsJSON(
      restored.elements,
      restored.appState,
      restored.files,
      'local',
    ),
    initialData: restored,
  };
}

export function ExcalidrawPane({
  activePath,
  content,
  documentEpoch,
  documentId,
  editable,
  onContentChange,
  onInvalidScene,
  onPopout,
  paneRef,
  popout = false,
  popoutButton,
}: ExcalidrawPaneProps) {
  const { locale, t } = useI18n();
  const { appearance } = useObservedEffectiveTheme();
  const prepared = useMemo(() => {
    try {
      return prepareExcalidrawScene(content);
    } catch {
      return null;
    }
  }, [content]);
  const onContentChangeRef = useRef(onContentChange);
  const onInvalidSceneRef = useRef(onInvalidScene);
  const [sceneInstanceRevision, setSceneInstanceRevision] = useState(0);
  const sceneContentRef = useRef({
    appTheme: prepared?.initialData.appState.theme,
    canonicalContent: prepared?.canonicalContent ?? null,
    content,
    documentToken: `${documentId}:${documentEpoch}`,
  });
  const reportedInvalidSceneRef = useRef<string | null>(null);
  const documentToken = `${documentId}:${documentEpoch}`;

  onContentChangeRef.current = onContentChange;
  onInvalidSceneRef.current = onInvalidScene;

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
  }, [content, documentToken, locale, prepared]);

  const handleChange = useCallback<ExcalidrawChange>((elements, appState, files) => {
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

  const className = popout ? 'excalidraw-pane popout-pane' : 'excalidraw-pane';
  const title = editable ? 'Excalidraw' : t('excalidrawPreview');
  const subtitle = activePath ? displayName(activePath) : 'Untitled.excalidraw';

  return (
    <section className={className} ref={paneRef}>
      <PaneHeader title={title} subtitle={subtitle} popoutButton={popoutButton} onPopout={onPopout} />
      <div className="excalidraw-viewport">
        {prepared && (
          <Excalidraw
            key={`${documentToken}:${sceneInstanceRevision}`}
            aiEnabled={false}
            initialData={prepared.initialData}
            theme={appearance}
            UIOptions={{
              canvasActions: {
                export: { saveFileToDisk: false },
                loadScene: false,
                saveToActiveFile: false,
              },
            }}
            viewModeEnabled={!editable}
            onChange={handleChange}
          />
        )}
      </div>
    </section>
  );
}
