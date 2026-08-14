import { Download, X } from 'lucide-react';
import type { EffectiveLocale } from '../lib/locale';

interface UpdateAvailableDialogProps {
  locale: EffectiveLocale;
  version: string;
  currentVersion: string;
  body?: string;
  busy: boolean;
  onUpdate: () => Promise<void>;
  onLater: () => void;
  onSkip: () => void;
}

const copy = {
  en: {
    title: (version: string) => `mdx ${version} is available`,
    current: (version: string) => `Current version: ${version}`,
    fallback: 'A newer signed version of mdx is ready to install.',
    update: 'Update now',
    later: 'Later',
    skip: 'Skip this version',
    close: 'Close',
  },
  'zh-CN': {
    title: (version: string) => `mdx ${version} 可用`,
    current: (version: string) => `当前版本：${version}`,
    fallback: '已有经过签名验证的新版本可供安装。',
    update: '立即更新',
    later: '稍后',
    skip: '跳过此版本',
    close: '关闭',
  },
};

export function UpdateAvailableDialog(props: UpdateAvailableDialogProps) {
  const text = copy[props.locale];
  return (
    <div className="settings-dialog-backdrop">
      <dialog open className="settings-dialog update-dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <header className="settings-dialog-header">
          <div className="settings-dialog-heading">
            <Download size={18} aria-hidden="true" />
            <h2 id="update-dialog-title">{text.title(props.version)}</h2>
          </div>
          <button type="button" className="settings-dialog-close" aria-label={text.close} title={text.close} disabled={props.busy} onClick={props.onLater}><X size={17} /></button>
        </header>
        <p className="update-dialog-current">{text.current(props.currentVersion)}</p>
        <div className="update-dialog-notes">{props.body?.trim() || text.fallback}</div>
        <div className="settings-dialog-actions">
          <button type="button" className="dialog-button ghost" disabled={props.busy} onClick={props.onSkip}>{text.skip}</button>
          <button type="button" className="dialog-button ghost" disabled={props.busy} onClick={props.onLater}>{text.later}</button>
          <button type="button" className="dialog-button secondary" disabled={props.busy} onClick={() => void props.onUpdate()}><Download size={14} aria-hidden="true" />{text.update}</button>
        </div>
      </dialog>
    </div>
  );
}
