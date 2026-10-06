import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import {
  MARKDOWN_FORMAT_COMMANDS,
  type MarkdownFormatCommand,
  type MarkdownFormatCommandId,
} from '../../lib/markdownFormatCommands';
import {
  FormatCommandList,
  FormatDialogHeader,
  FormatDialogSearchInput,
  FormatDialogShell,
  handleSearchInputKey,
  type LocalizedFormatCommand,
} from './markdownFormatDialogView';

const COMMAND_ZH: Record<MarkdownFormatCommandId, string> = {
  h1: '一级标题', h2: '二级标题', h3: '三级标题', bold: '粗体', italic: '斜体',
  strikethrough: '删除线', 'inline-code': '行内代码', 'inline-formula': '行内公式', link: '链接', blockquote: '引用',
  'bullet-list': '无序列表', 'ordered-list': '有序列表', 'task-list': '任务列表',
  table: '表格', 'code-block': '代码块', mermaid: 'Mermaid 图表', 'formula-block': '公式块',
  'horizontal-rule': '分割线', image: '图片', video: '视频', meme: '梗图', 'html-embed': 'HTML 嵌入',
  'alert-tip': '提示块', 'alert-info': '信息块', 'alert-warning': '警告块', 'alert-error': '错误块',
};

const CATEGORY_ZH: Record<string, string> = { Text: '文本', Blocks: '块', Media: '媒体', Alerts: '提示' };

interface MarkdownFormatDialogProps {
  onCancel: () => void;
  onFocusLeave: () => void;
  onSelect: (command: MarkdownFormatCommandId) => void;
}


function commandMatches(command: Pick<MarkdownFormatCommand, 'category' | 'keywords' | 'label' | 'syntax'> | { category: string; keywords: string; label: string; syntax: string }, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${command.label} ${command.category} ${command.keywords} ${command.syntax}`
    .toLowerCase()
    .includes(normalized);
}

export function MarkdownFormatDialog({ onCancel, onFocusLeave, onSelect }: MarkdownFormatDialogProps) {
  const { locale } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const activeCommandRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo<LocalizedFormatCommand[]>(
    () => MARKDOWN_FORMAT_COMMANDS
      .map((command) => locale === 'zh-CN' ? { ...command, label: COMMAND_ZH[command.id], category: CATEGORY_ZH[command.category] ?? command.category } : command)
      .filter((command) => commandMatches(command, query)),
    [locale, query]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActiveIndex(0); }, [query]);

  useEffect(() => { activeCommandRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [activeIndex, commands]);

  const chooseActiveCommand = () => {
    const command = commands[activeIndex];
    if (command) onSelect(command.id);
  };

  return (
    <FormatDialogShell
      onCancel={onCancel}
      onFocusLeave={onFocusLeave}
      header={<FormatDialogHeader onCancel={onCancel} />}
      search={(
        <FormatDialogSearchInput
          activeCommandId={commands[activeIndex]?.id}
          inputRef={inputRef}
          onNavigate={handleSearchInputKey({ chooseActiveCommand, commands, setActiveIndex })}
          onQueryChange={setQuery}
          query={query}
        />
      )}
      list={(
        <FormatCommandList
          activeCommandRef={activeCommandRef}
          activeIndex={activeIndex}
          commands={commands}
          onHover={setActiveIndex}
          onSelect={onSelect}
        />
      )}
    />
  );
}
