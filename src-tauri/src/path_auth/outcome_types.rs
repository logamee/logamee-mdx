//! Rename/copy/delete outcome types.
use super::*;

pub(crate) struct RenamedWorkspaceEntry {
    pub(crate) workspace: AuthorizedWorkspace,
    pub(crate) old_path: PathBuf,
    pub(crate) new_path: PathBuf,
    pub(crate) is_file: bool,
}

pub(crate) struct CopiedWorkspaceEntry {
    pub(crate) workspace: AuthorizedWorkspace,
    pub(crate) source: PathBuf,
    pub(crate) target: PathBuf,
    pub(crate) is_file: bool,
}

pub(crate) enum CopyWorkspaceEntryOutcome {
    Committed(CopiedWorkspaceEntry),
    /// The staged copy installed nothing at the destination name.
    ConfirmedNotCommitted {
        message: String,
    },
    /// The copy was installed, but its durability could not be proven.
    Indeterminate {
        copied: CopiedWorkspaceEntry,
        recovery_message: String,
    },
}

pub(crate) struct DeletedWorkspaceEntry {
    pub(crate) workspace: AuthorizedWorkspace,
    pub(crate) deleted_path: PathBuf,
    #[cfg(test)]
    pub(crate) is_file: bool,
}

pub(crate) enum AuthorizedRenameOutcome {
    ConfirmedNotCommitted {
        message: String,
    },
    Committed(RenamedWorkspaceEntry),
    RecoveryRequired {
        renamed: RenamedWorkspaceEntry,
        recovery_message: String,
    },
    Indeterminate {
        attempted: RenamedWorkspaceEntry,
        recovery_message: String,
    },
}

pub(crate) enum RenameErrorObservation {
    ConfirmedNotCommitted,
    ConfirmedCommitted,
    Indeterminate { message: String },
}

pub(crate) enum RenameWorkspaceEntryAuthorizationOutcome {
    Committed {
        renamed: RenamedWorkspaceEntry,
        invalidated_preview_leases: HashSet<PreviewLeaseId>,
    },
    AwaitingObservation {
        attempted: RenamedWorkspaceEntry,
        transitioned_grants: HashSet<GrantKey>,
        operation_error: String,
    },
    ConfirmedNotCommitted {
        message: String,
    },
    Indeterminate {
        attempted: RenamedWorkspaceEntry,
        invalidated_preview_leases: HashSet<PreviewLeaseId>,
        operation_error: String,
        observation_message: String,
    },
}

pub(crate) enum AuthorizedDeleteOutcome {
    ConfirmedNotCommitted {
        message: String,
    },
    Committed(DeletedWorkspaceEntry),
    RecoveryRequired {
        deleted: DeletedWorkspaceEntry,
        recovery_message: String,
    },
    Indeterminate {
        attempted: DeletedWorkspaceEntry,
        recovery_message: String,
    },
}

#[cfg(test)]
pub(crate) enum DeleteFileObservation {
    Present,
    Missing,
}

pub(crate) enum TrashAuthorizationDisposition {
    ConfirmedCommitted,
    ConfirmedNotCommitted { message: String },
    Indeterminate { message: String },
}

pub(crate) enum DeleteWorkspaceEntryAuthorizationOutcome {
    ConfirmedNotCommitted {
        message: String,
    },
    Committed {
        deleted: DeletedWorkspaceEntry,
        invalidated_preview_leases: HashSet<PreviewLeaseId>,
    },
    Indeterminate {
        attempted: DeletedWorkspaceEntry,
        invalidated_preview_leases: HashSet<PreviewLeaseId>,
        operation_error: String,
    },
}

#[cfg(test)]
pub(crate) enum AuthorizedWriteOutcome {
    Committed(PathBuf),
    Indeterminate {
        path: PathBuf,
        recovery_message: String,
    },
}
