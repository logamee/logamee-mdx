import { Keyboard } from 'lucide-react';
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { normalizeShortcut, type ShortcutAction } from '../../lib/shortcutProfiles';
import type { SettingsDialogText } from './settingsDialogCopy';

type RecordedKeyEvent = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>;

function expandsWhenUppercased(key: string): boolean {
  return key.length === 1 && key.toUpperCase().length !== 1;
}

function recordedModifiers(event: RecordedKeyEvent, isMac: boolean): string[] | null {
  if (event.metaKey && !isMac) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push('Mod');
  if (event.ctrlKey) parts.push(isMac ? 'Ctrl' : 'Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  return parts;
}

function formatRecordedShortcut(event: RecordedKeyEvent): string | null {
  const modifiers = recordedModifiers(event, navigator.platform.toLowerCase().includes('mac'));
  if (!modifiers || expandsWhenUppercased(event.key)) return null;
  try {
    return normalizeShortcut([...modifiers, event.key].join('+'));
  } catch {
    return null;
  }
}

interface ShortcutFieldRowProps {
  action: ShortcutAction;
  label: string;
  onChange: (value: string) => void;
  text: SettingsDialogText;
  value: string;
}

export function ShortcutFieldRow({ action, label, onChange, text, value }: ShortcutFieldRowProps) {
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!recording) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setRecording(false);
      return;
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const recorded = formatRecordedShortcut(event.nativeEvent);
    if (!recorded) return;
    onChange(recorded);
    setRecording(false);
  };

  return (
    <label className="settings-field">
      <span>{label}</span>
      <span className="settings-shortcut-control">
        <input
          name={`shortcut-${action}`}
          ref={inputRef}
          type="text"
          value={recording ? '' : value}
          readOnly={recording}
          placeholder={recording ? text.shortcutRecordingPrompt : undefined}
          className={recording ? 'is-recording' : undefined}
          onBlur={() => setRecording(false)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className={recording ? 'settings-icon-button is-recording' : 'settings-icon-button'}
          aria-label={recording ? text.shortcutRecordingStop : text.shortcutRecord}
          aria-pressed={recording}
          title={recording ? text.shortcutRecordingStop : text.shortcutRecord}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!recording) inputRef.current?.focus();
            setRecording(!recording);
          }}
        >
          <Keyboard size={14} aria-hidden="true" />
        </button>
      </span>
    </label>
  );
}
