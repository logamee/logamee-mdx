import { WorkspaceSearchDialog, type WorkspaceSearchSelection } from './WorkspaceSearchDialog';

interface QuickOpenDialogProps {
  workspaceRoot: string;
  workspaceToken: string;
  onCancel: () => void;
  onError: (error: unknown) => void;
  onSelect: (selection: WorkspaceSearchSelection) => void;
}

export function QuickOpenDialog(props: QuickOpenDialogProps) {
  return <WorkspaceSearchDialog {...props} mode="quick-open" />;
}
