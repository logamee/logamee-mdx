import { listen, TauriEvent } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getPanePopoutLabel, getPanePopoutUrl, type PopoutCapablePane } from './paneLayout';
import type { PaneWindowBackend, PaneWindowHandle } from './paneWindow';

function paneWindowHandle(webview: WebviewWindow): PaneWindowHandle {
  return {
    focus: () => webview.setFocus(),
    destroy: () => webview.destroy(),
  };
}

function paneWindowOptions(pane: PopoutCapablePane, instanceId?: string) {
  return {
    url: getPanePopoutUrl(pane, instanceId),
    title: pane === 'editor' ? 'mdx Editor' : 'mdx Live Preview',
    width: pane === 'editor' ? 760 : 900,
    height: 760,
    minWidth: pane === 'editor' ? 420 : 520,
    minHeight: 420,
  };
}

export class TauriPaneWindowBackend implements PaneWindowBackend {
  async lookup(pane: PopoutCapablePane): Promise<PaneWindowHandle | null> {
    const webview = await WebviewWindow.getByLabel(getPanePopoutLabel(pane));
    return webview ? paneWindowHandle(webview) : null;
  }

  create(pane: PopoutCapablePane, instanceId?: string): Promise<PaneWindowHandle> {
    const webview = new WebviewWindow(getPanePopoutLabel(pane), paneWindowOptions(pane, instanceId));
    const handle = paneWindowHandle(webview);

    return new Promise((resolve, reject) => {
      let settled = false;
      const unlisteners: Array<() => void> = [];
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        unlisteners.splice(0).forEach((unlisten) => unlisten());
        complete();
      };
      const register = (registration: Promise<() => void>) => {
        void registration.then((unlisten) => {
          if (settled) unlisten();
          else unlisteners.push(unlisten);
        }).catch((error: unknown) => settle(() => reject(error)));
      };

      register(webview.once('tauri://created', () => settle(() => resolve(handle))));
      register(webview.once<unknown>('tauri://error', (event) => settle(() => reject(event.payload))));
    });
  }

  listenDestroyed(pane: PopoutCapablePane, listener: () => void): Promise<() => void> {
    return listen(TauriEvent.WINDOW_DESTROYED, listener, {
      target: { kind: 'WebviewWindow', label: getPanePopoutLabel(pane) },
    });
  }
}
