import { useI18n } from '../../lib/i18n';
import type { MarkdownFormatCommandId } from '../../lib/markdownFormatCommands';
import type { MarkdownFormatCommand } from '../../lib/markdownFormatCommands';
import {
  Bold, CircleX, Code2, Globe, Heading1, Heading2, Heading3, Image as ImageIcon,
  Info, Italic, Lightbulb, Link2, List, ListChecks, ListOrdered, Minus, Quote, Radical,
  Search, Sigma, SquareCode, Sticker, Strikethrough, Table, TriangleAlert, Video, Workflow, X,
  type LucideIcon,
} from 'lucide-react';

// 本地化命令：中文覆盖 label/category 后类别放宽为 string。
export type LocalizedFormatCommand = Omit<MarkdownFormatCommand, 'category'> & { category: string };

const COMMAND_ICONS: Record<MarkdownFormatCommandId, LucideIcon> = {
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bold: Bold,
  italic: Italic,
  strikethrough: Strikethrough,
  'inline-code': Code2,
  'inline-formula': Radical,
  link: Link2,
  blockquote: Quote,
  'bullet-list': List,
  'ordered-list': ListOrdered,
  'task-list': ListChecks,
  table: Table,
  'code-block': SquareCode,
  mermaid: Workflow,
  'formula-block': Sigma,
  'horizontal-rule': Minus,
  image: ImageIcon,
  video: Video,
  meme: Sticker,
  'html-embed': Globe,
  'alert-tip': Lightbulb,
  'alert-info': Info,
  'alert-warning': TriangleAlert,
  'alert-error': CircleX,
};

// 对话框外壳：非模态，失焦离开与 Escape 取消。
export function FormatDialogShell(props: {
  header: React.ReactNode;
  list: React.ReactNode;
  onCancel: () => void;
  onFocusLeave: () => void;
  search: React.ReactNode;
}) {
  return (
    <>
      {/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/prefer-tag-over-role -- The non-modal dialog delegates focus lifecycle, and its rich combobox results cannot use native select options. */}
      <dialog
        open
        className="markdown-format-dialog"
        aria-labelledby="markdown-format-dialog-title"
        onBlur={(event) => {
          const nextFocus = event.relatedTarget;
          if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) return;
          props.onFocusLeave();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          props.onCancel();
        }}
      >
        <div className="markdown-format-dialog-header">
          {props.header}
          {props.search}
        </div>
        {props.list}
      </dialog>
      {/* oxlint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/prefer-tag-over-role */}
    </>
  );
}

// 头部标题行与关闭按钮。
export function FormatDialogHeader(props: { onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div className="markdown-format-dialog-title-row">
      <h2 id="markdown-format-dialog-title">{t('format')}</h2>
      <button
        type="button"
        className="markdown-format-dialog-close"
        aria-label={t('cancel')}
        title={t('cancel')}
        onClick={props.onCancel}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

// 搜索输入：combobox 语义 + 上下循环与回车确认。
export function FormatDialogSearchInput(props: {
  activeCommandId: string | undefined;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onNavigate: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onQueryChange: (query: string) => void;
  query: string;
}) {
  const { t } = useI18n();
  return (
    <label className="markdown-format-search">
      <Search size={15} aria-hidden="true" />
      <input
        ref={props.inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-controls="markdown-format-command-list"
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-label={t('searchFormatCommands')}
        aria-activedescendant={props.activeCommandId ? `markdown-format-${props.activeCommandId}` : undefined}
        placeholder={t('searchFormats')}
        spellCheck={false}
        value={props.query}
        onChange={(event) => props.onQueryChange(event.currentTarget.value)}
        onKeyDown={props.onNavigate}
      />
    </label>
  );
}

// 输入键盘处理：ArrowDown/Up 循环移动，Enter 确认。
export function handleSearchInputKey(handlers: {
  chooseActiveCommand: () => void;
  commands: readonly unknown[];
  setActiveIndex: (update: (index: number) => number) => void;
}): (event: React.KeyboardEvent<HTMLInputElement>) => void {
  return (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      handlers.setActiveIndex((index) => handlers.commands.length ? (index + 1) % handlers.commands.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      handlers.setActiveIndex((index) => handlers.commands.length ? (index - 1 + handlers.commands.length) % handlers.commands.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      handlers.chooseActiveCommand();
    }
  };
}

// 命令列表：激活项滚动可见，悬停跟随激活，指针按下不抢焦点。
export function FormatCommandList(props: {
  activeCommandRef: React.RefObject<HTMLButtonElement | null>;
  activeIndex: number;
  commands: readonly LocalizedFormatCommand[];
  onHover: (index: number) => void;
  onSelect: (id: MarkdownFormatCommandId) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      id="markdown-format-command-list"
      className="markdown-format-command-list"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 富组合框结果列表无法用原生 select/datalist 表达
      role="listbox"
      aria-label={t('formatCommands')}
    >
      {props.commands.map((command, index) => {
        const Icon = COMMAND_ICONS[command.id];
        return (
          <button
            key={command.id}
            ref={index === props.activeIndex ? props.activeCommandRef : undefined}
            id={`markdown-format-${command.id}`}
            type="button"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 选项随激活态管理，非原生 option 可表达
            role="option"
            aria-selected={index === props.activeIndex}
            tabIndex={-1}
            className={index === props.activeIndex ? 'markdown-format-command active' : 'markdown-format-command'}
            data-command-id={command.id}
            onClick={() => props.onSelect(command.id)}
            onFocus={() => props.onHover(index)}
            onMouseMove={() => props.onHover(index)}
            onPointerDown={(event) => event.preventDefault()}
          >
            <Icon className={`markdown-format-command-icon ${command.id}`} size={16} aria-hidden="true" />
            <span className="markdown-format-command-copy">
              <strong>{command.label}</strong>
              <small>{command.category}</small>
            </span>
            <code>{command.syntax}</code>
          </button>
        );
      })}
      {props.commands.length === 0 && <p className="markdown-format-empty">{t('noMatchingFormats')}</p>}
    </div>
  );
}
