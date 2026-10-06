import { useEditorPaneController } from './editorPaneController';
import { EditorPaneView } from './editorPaneView';
import type { EditorPaneProps } from './editorPaneTypes';

export type { ClipboardImagePasteRequest, EditorPaneProps } from './editorPaneTypes';

// Markdown/HTML 源码编辑面板：控制器聚合 CodeMirror 会话与交互，视图负责渲染。
export function EditorPane(props: EditorPaneProps) {
  const ctrl = useEditorPaneController(props);
  return <EditorPaneView ctrl={ctrl} paneProps={props} />;
}
