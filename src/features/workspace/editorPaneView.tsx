import { ZoomIn, ZoomOut } from 'lucide-react';
import { MarkdownFormatDialog } from './MarkdownFormatDialog';
import { PaneHeader } from '../../components/PaneHeader';
import { VimLogo } from './VimLogo';
import { displayName } from '../../lib/documentNames';
import { useI18n, type Translate } from '../../lib/i18n';
import { MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE } from '../../lib/settings';
import { EditorContextMenuList } from './editorPaneContextMenu';
import type { useEditorPaneController } from './editorPaneController';
import type { EditorPaneProps, EditorStatus } from './editorPaneTypes';

type EditorPaneController = ReturnType<typeof useEditorPaneController>;

function EditorVimToggle(props: { enabled: boolean; onToggle: (enabled: boolean) => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={props.enabled ? 'pane-vim-button is-active' : 'pane-vim-button'}
      title={props.enabled ? t('disableVim') : t('enableVim')}
      aria-label={props.enabled ? t('disableVim') : t('enableVim')}
      aria-pressed={props.enabled}
      onClick={() => props.onToggle(!props.enabled)}
    >
      <VimLogo className="vim-logo" />
    </button>
  );
}

// 字号控制：减小/复原/增大，边界值与回调缺失时禁用对应按钮。
function EditorFontControls(props: {
  fontSize: number;
  onDecrease?: () => void;
  onIncrease?: () => void;
  onReset?: () => void;
  t: Translate;
}) {
  const { t } = props;
  return (
    <span className="editor-status-font" role="toolbar" aria-label={t('editorFontSizeControl')}>
      <button
        type="button"
        className="editor-status-font-button"
        data-editor-font-action="decrease"
        aria-label={t('editorFontDecrease')}
        title={t('editorFontDecrease')}
        disabled={props.fontSize <= MIN_EDITOR_FONT_SIZE || !props.onDecrease}
        onClick={() => props.onDecrease?.()}
      >
        <ZoomOut size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="editor-status-font-value"
        data-editor-font-action="reset"
        aria-label={t('editorFontReset')}
        title={t('editorFontReset')}
        disabled={!props.onReset}
        onClick={() => props.onReset?.()}
      >
        {props.fontSize}px
      </button>
      <button
        type="button"
        className="editor-status-font-button"
        data-editor-font-action="increase"
        aria-label={t('editorFontIncrease')}
        title={t('editorFontIncrease')}
        disabled={props.fontSize >= MAX_EDITOR_FONT_SIZE || !props.onIncrease}
        onClick={() => props.onIncrease?.()}
      >
        <ZoomIn size={13} aria-hidden="true" />
      </button>
    </span>
  );
}

// 状态栏：字数/字符/行数/行列光标，可选字号控制。
function EditorStatusBar(props: { editorStatus: EditorStatus; paneProps: EditorPaneProps }) {
  const { t } = useI18n();
  const { editorStatus, paneProps } = props;
  return (
    <footer className="editor-status" aria-label={t('editorStatus')}>
      <span className="editor-status-stat editor-status-words">{t('words', { count: editorStatus.words })}</span>
      <span className="editor-status-stat editor-status-characters">{t('characters', { count: editorStatus.characters })}</span>
      <span className="editor-status-stat editor-status-lines">{t('lines', { count: editorStatus.lines })}</span>
      <span className="editor-status-cursor">{t('lineColumn', { line: editorStatus.line, column: editorStatus.column })}</span>
      {paneProps.fontSize !== undefined && (
        <EditorFontControls
          fontSize={paneProps.fontSize}
          onDecrease={paneProps.onFontSizeDecrease}
          onIncrease={paneProps.onFontSizeIncrease}
          onReset={paneProps.onFontSizeReset}
          t={t}
        />
      )}
    </footer>
  );
}

// 编辑器面板视图：标题工具条、编辑器宿主、状态栏、右键菜单与格式面板。
export function EditorPaneView(props: { ctrl: EditorPaneController; paneProps: EditorPaneProps }) {
  const { ctrl, paneProps } = props;
  const { t } = useI18n();
  const editable = paneProps.editable ?? true;
  const fileKind = paneProps.fileKind ?? 'markdown';
  return (
    <section className={paneProps.popout ? 'editor-pane popout-pane' : 'editor-pane'} ref={paneProps.paneRef}>
      <PaneHeader
        title={t('editor')}
        subtitle={displayName(paneProps.activePath)}
        beforePopout={<EditorVimToggle enabled={ctrl.vimModeEnabled} onToggle={ctrl.setVimModeEnabled} />}
        popoutButton={paneProps.popoutButton}
        onPopout={paneProps.onPopout}
      />
      <div
        aria-label={ctrl.editorLabel}
        className="editor-host"
        data-markdown-media-drop-target={editable && fileKind === 'markdown' ? 'true' : undefined}
        onContextMenuCapture={ctrl.contextMenu.handleEditorContextMenuCapture}
        onKeyDownCapture={ctrl.handleEditorKeyDownCapture}
        ref={ctrl.editorHostRef}
      />
      <EditorStatusBar editorStatus={ctrl.editorStatus} paneProps={paneProps} />
      {ctrl.contextMenu.contextMenuState && (
        <EditorContextMenuList
          contextMenuRef={ctrl.contextMenu.contextMenuRef}
          contextMenuState={ctrl.contextMenu.contextMenuState}
          onApplyCommand={ctrl.applyContextMenuCommand}
          onApplyInsert={ctrl.applyContextMenuInsert}
          onOpenFormatPalette={() => {
            ctrl.contextMenu.dismissContextMenu();
            ctrl.setFormatDialogOpen(true);
          }}
        />
      )}
      {ctrl.formatDialogOpen && (
        <MarkdownFormatDialog
          onCancel={ctrl.closeFormatDialog}
          onFocusLeave={ctrl.dismissFormatDialog}
          onSelect={ctrl.applyFormatCommand}
        />
      )}
    </section>
  );
}
