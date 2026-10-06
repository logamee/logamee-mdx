use serde::Serialize;

use super::{MarkdownFileEntry, PreparedOpenFileResponse, WorkspaceDirectoryEntry};

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceDirectoryListing {
    pub(crate) root: String,
    pub(crate) files: Vec<MarkdownFileEntry>,
    pub(crate) directories: Vec<WorkspaceDirectoryEntry>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceSnapshot {
    pub(crate) workspace_token: String,
    pub(crate) root: String,
    pub(crate) files: Vec<MarkdownFileEntry>,
    pub(crate) directories: Vec<WorkspaceDirectoryEntry>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceSessionRestore {
    pub(crate) workspace: WorkspaceSnapshot,
    pub(crate) active_file: Option<PreparedOpenFileResponse>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceMutation {
    pub(crate) path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct RenameWorkspaceEntryResponse {
    pub(crate) entry_kind: String,
    pub(crate) old_path: String,
    pub(crate) new_path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct DeleteWorkspaceEntryResponse {
    pub(crate) deleted_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MutationKind {
    Create,
    Delete,
    Rename,
    #[allow(dead_code)] // 协议契约：前端 MutationKind 解码覆盖 "write"
    Write,
    Copy,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status")]
pub(crate) enum SnapshotReceipt<S> {
    #[serde(rename = "fresh")]
    Fresh { snapshot: S },
    #[serde(rename = "stale")]
    Stale {
        workspace_token: String,
        repair_reason: String,
    },
    #[serde(rename = "not-applicable")]
    #[allow(dead_code)] // 协议契约：快照回执三态之一，前端解码覆盖 "not-applicable"
    NotApplicable,
}

#[derive(Debug, Serialize)]
pub(crate) struct MutationCommitReceipt<T, S> {
    pub(crate) committed: T,
    pub(crate) workspace: SnapshotReceipt<S>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status")]
pub(crate) enum MutationOutcome<T, S> {
    #[serde(rename = "confirmed-not-committed")]
    ConfirmedNotCommitted { message: String },
    #[serde(rename = "confirmed-committed")]
    ConfirmedCommitted {
        receipt: MutationCommitReceipt<T, S>,
    },
    #[serde(rename = "indeterminate")]
    Indeterminate {
        operation: MutationKind,
        paths: Vec<String>,
        recovery_message: String,
    },
}
