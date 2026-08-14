import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EffectiveLocale } from './locale';
import type { LocaleRuntime } from './localeRuntime';

const en = {
  working: 'Working', edited: 'Edited', saved: 'Saved', currentDocument: 'Current document',
  workspaceFiles: 'Workspace files', workspace: 'Workspace', files: 'Files', outline: 'Outline',
  addWorkspaceItem: 'Add workspace item', newMarkdownFile: 'New Markdown File',
  newExcalidrawFile: 'New Excalidraw File', newFolder: 'New Folder', refreshWorkspace: 'Refresh workspace',
  workspaceViews: 'Workspace views', workspaceFileTree: 'Workspace file tree', noFolderOpen: 'No folder open', folderEmpty: 'This folder is empty',
  noHeadings: 'No headings in this document', documentOutline: 'Document outline',
  collapseFileTree: 'Collapse file tree', expandFileTree: 'Expand file tree',
  moreActions: 'More actions for {name}', expandFolder: 'Expand {name}', collapseFolder: 'Collapse {name}',
  renameItem: 'Rename {name}', openDocument: 'Open document', insertAtCurrentCursor: 'Insert at Current Cursor', editor: 'Editor', livePreview: 'Live Preview',
  synced: 'synced', modified: 'modified', enableVim: 'Enable Vim editing mode', disableVim: 'Disable Vim editing mode',
  markdownSourceEditor: 'Markdown source editor', htmlSourceEditor: 'HTML source editor', editorStatus: 'Editor status',
  words: 'Words {count}', characters: 'Characters {count}', lines: 'Lines {count}', lineColumn: 'Line {line}, Column {column}',
  resizePanes: 'Resize editor and preview panes', resizeSidebar: 'Resize workspace sidebar',
  popOutEditor: 'Pop out editor', popOutPreview: 'Pop out live preview', popoutOpen: '{pane} is open in a separate window; click to focus it', poppedOut: 'Popped out',
  previewZoom: 'Preview zoom', zoomOut: 'Zoom out', resetZoom: 'Reset zoom', zoomIn: 'Zoom in',
  copyCode: 'Copy code', copied: 'Copied', format: 'Format', searchFormatCommands: 'Search format commands',
  searchFormats: 'Search formats', formatCommands: 'Format commands', noMatchingFormats: 'No matching formats',
  quickOpen: 'Quick Open', workspaceSearch: 'Workspace Search', searchWorkspace: 'Search workspace', exportDocument: 'Export document',
  searchFiles: 'Search files', searchContent: 'Search file contents', rebuildingIndex: 'Building workspace index…',
  noSearchResults: 'No matching files', resultsTruncated: 'More matches are available. Refine the search.',
  rebuildIndex: 'Rebuild index', openSearchResult: 'Open {path}', searchUnavailable: 'Open a workspace to search files.',
  workspaceIndexDiscarded: 'The workspace search index was discarded.', workspaceIndexRebuilt: 'The workspace search index is ready.',
  create: 'Create', rename: 'Rename', delete: 'Move to Trash', cancel: 'Cancel', move: 'Move', name: 'Name', moveTo: 'Move to',
  createExcalidrawTitle: 'New Excalidraw File', createFileTitle: 'New File', createFolderTitle: 'New Folder',
  renameFileTitle: 'Rename File', renameFolderTitle: 'Rename Folder', deleteFileTitle: 'Move File to Trash', deleteFolderTitle: 'Move Folder to Trash',
  createExcalidrawMessage: 'Create an Excalidraw scene in “{parent}”.', createFileMessage: 'Create a Markdown file in “{parent}”.',
  createFolderMessage: 'Create a folder in “{parent}”.', renameFileMessage: 'Rename “{name}”.', renameFolderMessage: 'Rename folder “{name}”.',
  deleteFileMessage: 'Move “{name}” to the system Trash? You can restore it from the system Trash.',
  deleteFolderMessage: 'Move folder “{name}” and its contents to the system Trash? You can restore it from the system Trash.',
  moveTitle: 'Move “{name}”', moveMessage: 'Choose a destination folder inside the current workspace.', noMoveDestination: 'No other destination folder is available.',
  fileDeleted: 'File Deleted', fileChangedExternally: 'File Changed Externally',
  deletedDraftMessage: 'The file was deleted outside mdx. Save the current draft as a new file, or close it without saving.',
  externalChangeMessage: 'The file changed outside mdx while this document has unsaved edits. Choose which version to keep.',
  saveAs: 'Save As…', closeWithoutSaving: 'Close Without Saving', useExternalVersion: 'Use External Version', keepCurrentEdits: 'Overwrite with Current Edits',
  saving: 'Saving…', imagePreview: 'Image Preview', mediaPreview: 'Media Preview', docxPreview: 'DOCX preview', pdfPreview: 'PDF preview',
  loadingImage: 'Loading image…', loadingMedia: 'Loading media…', loadingDocx: 'Loading DOCX preview…', loadingPdf: 'Loading PDF preview…',
  loadingExcalidraw: 'Loading Excalidraw preview…',
  imageLoadFailed: 'Image could not be loaded.', mediaLoadFailed: 'Media could not be loaded.', htmlPreview: 'HTML Preview: {name}',
  loadingHtml: 'Loading page and external resources…', excalidrawPreview: 'Excalidraw Preview',
  startingHtmlPreview: 'Starting HTML preview service…', htmlPreviewUnavailable: 'HTML preview is temporarily unavailable.',
  excalidrawPreviewUnavailable: 'Excalidraw preview is temporarily unavailable.',
  markdownImageLoadFailed: '⚠ Image could not be displayed',
  docxPreviewFailure: 'This DOCX could not be displayed. The file may be damaged or unsupported.',
  docxPreviewDegraded: 'Some DOCX content could not be displayed completely. This preview includes only content that can be rendered safely.',
  pdfPreviewFailure: 'This PDF could not be displayed. The file may be damaged or unsupported.',
  watchedFileDeleted: '“{name}” was deleted from disk.', watchStopped: 'File monitoring stopped. Reopen the file and try again.',
  watchInterrupted: 'File monitoring was interrupted. Retrying…', watchUnavailable: 'mdx can no longer monitor this file. Reopen it and try again.',
  popoutOpenFailed: 'Could not open the {pane} window: {detail}',
  popoutInsertionUnavailable: 'Could not reach the editor window. Keep it open and try inserting again.',
  untitledDocument: 'Untitled.md',
  unsavedChanges: 'Unsaved Changes', unsavedExitMessage: '“{name}” has not been saved. Save before quitting?',
  unsavedSwitchMessage: '“{name}” has not been saved. Save before switching to “{target}”?',
  save: 'Save', quitApp: 'Quit', saveAndSwitch: 'Save and Switch', switchWithoutSaving: 'Switch Without Saving',
  problem: 'Something Went Wrong', notice: 'Notice', gotIt: 'OK', operationFailed: 'The operation could not be completed. Please try again.',
} as const;

type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  working: '处理中', edited: '已编辑', saved: '已保存', currentDocument: '当前文档',
  workspaceFiles: '工作区文件', workspace: '工作区', files: '文件', outline: '大纲',
  addWorkspaceItem: '新建工作区项目', newMarkdownFile: '新建 Markdown 文件', newExcalidrawFile: '新建 Excalidraw 文件',
  newFolder: '新建文件夹', refreshWorkspace: '刷新工作区', workspaceViews: '工作区视图', workspaceFileTree: '工作区文件树',
  noFolderOpen: '尚未打开文件夹', folderEmpty: '此文件夹为空', noHeadings: '当前文档没有标题', documentOutline: '文档大纲',
  collapseFileTree: '收起文件树', expandFileTree: '展开文件树', moreActions: '{name} 的更多操作',
  expandFolder: '展开 {name}', collapseFolder: '收起 {name}', renameItem: '重命名 {name}', openDocument: '打开文档', insertAtCurrentCursor: '在当前光标处插入',
  editor: '编辑器', livePreview: '实时预览', synced: '已同步', modified: '已修改', enableVim: '启用 Vim 编辑模式', disableVim: '停用 Vim 编辑模式',
  markdownSourceEditor: 'Markdown 源码编辑器', htmlSourceEditor: 'HTML 源码编辑器', editorStatus: '编辑器状态',
  words: '字数 {count}', characters: '字符 {count}', lines: '行数 {count}', lineColumn: '第 {line} 行，第 {column} 列',
  resizePanes: '调整编辑器与预览区宽度', resizeSidebar: '调整工作区侧栏宽度', popOutEditor: '在独立窗口打开编辑器',
  popOutPreview: '在独立窗口打开实时预览', popoutOpen: '{pane}已在独立窗口打开，点击切换到前台', poppedOut: '已弹出',
  previewZoom: '预览缩放', zoomOut: '缩小', resetZoom: '重置缩放', zoomIn: '放大', copyCode: '复制代码', copied: '已复制',
  format: '格式', searchFormatCommands: '搜索格式命令', searchFormats: '搜索格式', formatCommands: '格式命令', noMatchingFormats: '没有匹配的格式',
  quickOpen: '快速打开', workspaceSearch: '工作区搜索', searchWorkspace: '搜索工作区', exportDocument: '导出文档',
  searchFiles: '搜索文件', searchContent: '搜索文件内容', rebuildingIndex: '正在构建工作区索引…',
  noSearchResults: '没有匹配的文件', resultsTruncated: '还有更多匹配项，请缩小搜索范围。',
  rebuildIndex: '重建索引', openSearchResult: '打开 {path}', searchUnavailable: '请先打开工作区后再搜索文件。',
  workspaceIndexDiscarded: '工作区搜索索引已丢弃。', workspaceIndexRebuilt: '工作区搜索索引已准备就绪。',
  create: '创建', rename: '重命名', delete: '移到废纸篓', cancel: '取消', move: '移动', name: '名称', moveTo: '移动到',
  createExcalidrawTitle: '新建 Excalidraw 文件', createFileTitle: '新建文件', createFolderTitle: '新建文件夹',
  renameFileTitle: '重命名文件', renameFolderTitle: '重命名文件夹', deleteFileTitle: '将文件移到废纸篓', deleteFolderTitle: '将文件夹移到废纸篓',
  createExcalidrawMessage: '在“{parent}”中新建 Excalidraw 场景。', createFileMessage: '在“{parent}”中新建 Markdown 文件。',
  createFolderMessage: '在“{parent}”中新建文件夹。', renameFileMessage: '重命名“{name}”。', renameFolderMessage: '重命名文件夹“{name}”。',
  deleteFileMessage: '将“{name}”移到系统废纸篓？之后可从系统废纸篓恢复。',
  deleteFolderMessage: '将文件夹“{name}”及其中内容移到系统废纸篓？之后可从系统废纸篓恢复。',
  moveTitle: '移动“{name}”', moveMessage: '选择当前工作区内的目标文件夹。', noMoveDestination: '没有其他可用的目标文件夹。',
  fileDeleted: '文件已被删除', fileChangedExternally: '文件已在外部更改',
  deletedDraftMessage: '该文件已在 mdx 外部被删除。你可以将当前草稿另存为新文件，或不保存并关闭。',
  externalChangeMessage: '文件已在 mdx 外部更改，而当前文档仍有未保存编辑。请选择要保留的版本。',
  saveAs: '另存为…', closeWithoutSaving: '不保存并关闭', useExternalVersion: '使用外部版本', keepCurrentEdits: '用当前编辑覆盖',
  saving: '正在保存…', imagePreview: '图片预览', mediaPreview: '媒体预览', docxPreview: 'DOCX 预览', pdfPreview: 'PDF 预览',
  loadingImage: '正在加载图片…', loadingMedia: '正在加载媒体…', loadingDocx: '正在加载 DOCX 预览…', loadingPdf: '正在加载 PDF 预览…',
  loadingExcalidraw: '正在加载 Excalidraw 预览…',
  imageLoadFailed: '图片无法加载。', mediaLoadFailed: '媒体无法加载。', htmlPreview: 'HTML 预览：{name}', loadingHtml: '正在加载页面及外部资源…',
  excalidrawPreview: 'Excalidraw 预览', startingHtmlPreview: '正在启动 HTML 预览服务…', htmlPreviewUnavailable: 'HTML 预览暂时不可用。',
  excalidrawPreviewUnavailable: 'Excalidraw 预览暂时不可用。',
  markdownImageLoadFailed: '⚠ 图片暂时无法显示', docxPreviewFailure: '无法显示该 DOCX。文件可能已损坏或不受支持。',
  docxPreviewDegraded: '该 DOCX 的部分内容无法完整显示，当前预览仅包含可安全呈现的内容。',
  pdfPreviewFailure: '无法显示该 PDF。文件可能已损坏或不受支持。', watchedFileDeleted: '“{name}”已从磁盘中删除。',
  watchStopped: '文件监控已停止。请重新打开文件后重试。', watchInterrupted: '文件监控暂时中断，正在重试。',
  watchUnavailable: '无法继续监控当前文件。请重新打开后重试。', popoutOpenFailed: '无法打开 {pane} 独立窗口：{detail}',
  popoutInsertionUnavailable: '无法连接到独立编辑器。请保持窗口打开后再次插入。',
  untitledDocument: '未命名.md',
  unsavedChanges: '有未保存的更改', unsavedExitMessage: '“{name}” 尚未保存。退出前要保存吗？',
  unsavedSwitchMessage: '“{name}” 尚未保存。切换到“{target}”前要保存吗？', save: '保存', quitApp: '退出程序',
  saveAndSwitch: '保存并切换', switchWithoutSaving: '不保存并切换',
  problem: '出现问题', notice: '提示', gotIt: '知道了', operationFailed: '操作没有完成。请稍后重试。',
};

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

function formatMessage(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

export function translate(locale: EffectiveLocale, key: MessageKey, values?: Record<string, string | number>): string {
  return formatMessage((locale === 'zh-CN' ? zh : en)[key], values);
}

interface I18nValue {
  locale: EffectiveLocale;
  t: Translate;
}

const I18nContext = createContext<I18nValue>({ locale: 'en', t: (key, values) => translate('en', key, values) });

export function LocaleProvider({ children, runtime }: { children: ReactNode; runtime: LocaleRuntime }) {
  const [locale, setLocale] = useState(() => runtime.getSnapshot().effectiveLocale);
  useEffect(() => runtime.subscribe(() => setLocale(runtime.getSnapshot().effectiveLocale)), [runtime]);
  const value = useMemo<I18nValue>(() => ({ locale, t: (key, values) => translate(locale, key, values) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
