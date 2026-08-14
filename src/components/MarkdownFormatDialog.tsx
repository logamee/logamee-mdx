import {
  Bold,
  CircleX,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Info,
  Italic,
  Lightbulb,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Search,
  SquareCode,
  Strikethrough,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MARKDOWN_FORMAT_COMMANDS,
  type MarkdownFormatCommand,
  type MarkdownFormatCommandId,
} from '../lib/markdownFormatCommands';
import { useI18n } from '../lib/i18n';

const COMMAND_ZH: Record<MarkdownFormatCommandId, string> = {
  h1: '一级标题', h2: '二级标题', h3: '三级标题', bold: '粗体', italic: '斜体',
  strikethrough: '删除线', 'inline-code': '行内代码', link: '链接', blockquote: '引用',
  'bullet-list': '无序列表', 'ordered-list': '有序列表', 'task-list': '任务列表',
  'code-block': '代码块', 'alert-tip': '提示块', 'alert-info': '信息块',
  'alert-warning': '警告块', 'alert-error': '错误块',
};

const CATEGORY_ZH: Record<string, string> = { Text: '文本', Blocks: '块', Alerts: '提示' };

interface MarkdownFormatDialogProps {
  onCancel: () => void;
  onFocusLeave: () => void;
  onSelect: (command: MarkdownFormatCommandId) => void;
}

const COMMAND_ICONS: Record<MarkdownFormatCommandId, LucideIcon> = {
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bold: Bold,
  italic: Italic,
  strikethrough: Strikethrough,
  'inline-code': Code2,
  link: Link2,
  blockquote: Quote,
  'bullet-list': List,
  'ordered-list': ListOrdered,
  'task-list': ListChecks,
  'code-block': SquareCode,
  'alert-tip': Lightbulb,
  'alert-info': Info,
  'alert-warning': TriangleAlert,
  'alert-error': CircleX,
};

function commandMatches(command: Pick<MarkdownFormatCommand, 'category' | 'keywords' | 'label' | 'syntax'> | { category: string; keywords: string; label: string; syntax: string }, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${command.label} ${command.category} ${command.keywords} ${command.syntax}`
    .toLowerCase()
    .includes(normalized);
}

export function MarkdownFormatDialog({ onCancel, onFocusLeave, onSelect }: MarkdownFormatDialogProps) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const activeCommandRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(
    () => MARKDOWN_FORMAT_COMMANDS
      .map((command) => locale === 'zh-CN' ? { ...command, label: COMMAND_ZH[command.id], category: CATEGORY_ZH[command.category] ?? command.category } : command)
      .filter((command) => commandMatches(command, query)),
    [locale, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    activeCommandRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, commands]);

  const chooseActiveCommand = () => {
    const command = commands[activeIndex];
    if (command) onSelect(command.id);
  };

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
          onFocusLeave();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      >
        <div className="markdown-format-dialog-header">
          <div className="markdown-format-dialog-title-row">
            <h2 id="markdown-format-dialog-title">{t('format')}</h2>
            <button
              type="button"
              className="markdown-format-dialog-close"
              aria-label={t('cancel')}
              title={t('cancel')}
              onClick={onCancel}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <label className="markdown-format-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-autocomplete="list"
              aria-controls="markdown-format-command-list"
              aria-expanded="true"
              aria-haspopup="listbox"
              aria-label={t('searchFormatCommands')}
              aria-activedescendant={commands[activeIndex] ? `markdown-format-${commands[activeIndex].id}` : undefined}
              placeholder={t('searchFormats')}
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((index) => commands.length ? (index + 1) % commands.length : 0);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((index) => commands.length ? (index - 1 + commands.length) % commands.length : 0);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  chooseActiveCommand();
                }
              }}
            />
          </label>
        </div>
        <div
          id="markdown-format-command-list"
          className="markdown-format-command-list"
          role="listbox"
          aria-label={t('formatCommands')}
        >
          {commands.map((command, index) => {
            const Icon = COMMAND_ICONS[command.id];
            return (
              <button
                key={command.id}
                ref={index === activeIndex ? activeCommandRef : undefined}
                id={`markdown-format-${command.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                className={index === activeIndex ? 'markdown-format-command active' : 'markdown-format-command'}
                data-command-id={command.id}
                onClick={() => onSelect(command.id)}
                onFocus={() => setActiveIndex(index)}
                onMouseMove={() => setActiveIndex(index)}
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
          {commands.length === 0 && <p className="markdown-format-empty">{t('noMatchingFormats')}</p>}
        </div>
      </dialog>
      {/* oxlint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/prefer-tag-over-role */}
    </>
  );
}
