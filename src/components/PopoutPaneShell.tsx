import type { ReactNode } from 'react';

interface PopoutPaneShellProps {
  children: ReactNode;
}

export function PopoutPaneShell({ children }: PopoutPaneShellProps) {
  return <div className="app-shell popout-shell">{children}</div>;
}
