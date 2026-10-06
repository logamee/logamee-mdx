import {
  Excalidraw,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { Ref } from 'react';
import { displayName } from '../../lib/documentNames';
import type { PanePopoutButtonState } from '../../lib/paneLayout';
import { useObservedEffectiveTheme } from '../../lib/themeObservation';
import { PaneHeader } from '../../components/PaneHeader';
import { useI18n } from '../../lib/i18n';
import {
  useInvalidSceneReporting,
  usePreparedExcalidrawScene,
  useSceneChangeHandler,
  useSceneInstanceSync,
} from './excalidrawPaneScene';

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

export function ExcalidrawPane({
  activePath, content, documentEpoch, documentId, editable, onContentChange,
  onInvalidScene, onPopout, paneRef, popout = false, popoutButton,
}: ExcalidrawPaneProps) {
  const { t } = useI18n();
  const { appearance } = useObservedEffectiveTheme();
  const prepared = usePreparedExcalidrawScene(content);
  const documentToken = `${documentId}:${documentEpoch}`;
  const { sceneContentRef, sceneInstanceRevision } = useSceneInstanceSync({ content, documentToken, prepared });
  useInvalidSceneReporting({ content, documentToken, onInvalidScene, prepared });
  const handleChange = useSceneChangeHandler(sceneContentRef, onContentChange);

  return (
    <section className={popout ? 'excalidraw-pane popout-pane' : 'excalidraw-pane'} ref={paneRef}>
      <PaneHeader
        title={editable ? 'Excalidraw' : t('excalidrawPreview')}
        subtitle={activePath ? displayName(activePath) : 'Untitled.excalidraw'}
        popoutButton={popoutButton}
        onPopout={onPopout}
      />
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
