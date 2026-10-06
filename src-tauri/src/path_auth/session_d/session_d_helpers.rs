//! Secure-open helpers for the read paths in `session_d`.
use super::super::*;

/// The read authority a file qualified for while the authorization lock was
/// held: either an exact grant on the file or the most specific active
/// workspace directory grant covering it.
pub(super) enum ReadAuthority {
    Exact(ExactReadAuthority),
    Workspace {
        root: PathBuf,
        token: WorkspaceToken,
        binding: WorkspaceRootBinding,
    },
}

/// The exact-grant identity expectation for a workspace-bound document,
/// mirrored from `ExactReadAuthority` after the lock is released.
pub(super) enum ExactAuthority {
    Path,
    Identity(String),
}

pub(super) fn secure_open_error_message(canonical: &Path, error: std::io::Error) -> String {
    format!(
        "Failed to securely open file {}: {error}",
        canonical.display()
    )
}

pub(super) fn open_file_through_exact_authority(
    canonical: &Path,
    exact: ExactReadAuthority,
) -> Result<fs::File, String> {
    let file = open_regular_file_without_following_links(canonical)
        .map_err(|error| secure_open_error_message(canonical, error))?;
    if let ExactReadAuthority::Identity(expected) = exact {
        let actual = opened_file_platform_identity(&file).map_err(|error| {
            format!(
                "Failed to identify securely opened file {}: {error}",
                canonical.display()
            )
        })?;
        if actual != expected {
            return Err("Securely opened file identity changed after authorization".to_string());
        }
    }
    Ok(file)
}

pub(super) fn open_file_through_workspace_authority(
    canonical: &Path,
    root: PathBuf,
    token: WorkspaceToken,
    binding: WorkspaceRootBinding,
) -> Result<(fs::File, WorkspaceReadAuthorization), String> {
    let relative = canonical
        .strip_prefix(&root)
        .map_err(|_| {
            "File is outside the user-authorized session files and directories"
                .to_string()
        })?
        .to_path_buf();
    let file = binding
        .open_regular_file(&relative)
        .map_err(|error| secure_open_error_message(canonical, error))?;
    let file_identity = opened_file_platform_identity(&file).map_err(|error| {
        format!(
            "Failed to identify securely opened file {}: {error}",
            canonical.display()
        )
    })?;
    let file_binding = Arc::new(file.try_clone().map_err(|error| {
        format!(
            "Failed to retain securely opened file {}: {error}",
            canonical.display()
        )
    })?);
    let workspace_authorization = WorkspaceReadAuthorization {
        path: canonical.to_path_buf(),
        root,
        relative,
        token,
        root_binding: binding,
        file_binding,
        file_identity,
    };
    Ok((file, workspace_authorization))
}

pub(super) fn open_authorized_read_file(
    canonical: &Path,
    authority: ReadAuthority,
) -> Result<(fs::File, Option<WorkspaceReadAuthorization>), String> {
    match authority {
        ReadAuthority::Exact(exact) => {
            open_file_through_exact_authority(canonical, exact).map(|file| (file, None))
        }
        ReadAuthority::Workspace {
            root,
            token,
            binding,
        } => open_file_through_workspace_authority(canonical, root, token, binding)
            .map(|(file, authorization)| (file, Some(authorization))),
    }
}

/// Opens a workspace-bound document through the workspace's current root
/// binding, verifying the root is still current and that the opened object
/// matches the exact-grant identity expectation.
pub(super) fn open_workspace_file_through_current_binding(
    canonical: &Path,
    workspace: &AuthorizedWorkspace,
    exact: ExactAuthority,
) -> Result<(fs::File, String, PathBuf), String> {
    if !workspace.root_binding.is_current(&workspace.root) {
        return Err("Workspace root changed after authorization".into());
    }
    let relative = canonical
        .strip_prefix(&workspace.root)
        .map_err(|_| "Document path is outside the authorized workspace".to_string())?
        .to_path_buf();
    let file = workspace
        .root_binding
        .open_regular_file(&relative)
        .map_err(|error| {
            format!(
                "Failed to securely open file {}: {error}",
                canonical.display()
            )
        })?;
    let file_identity = opened_file_platform_identity(&file).map_err(|error| {
        format!(
            "Failed to identify securely opened file {}: {error}",
            canonical.display()
        )
    })?;
    if let ExactAuthority::Identity(expected) = exact {
        if file_identity != expected {
            return Err("Securely opened file identity changed after authorization".to_string());
        }
    }
    Ok((file, file_identity, relative))
}
