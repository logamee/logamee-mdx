//! Authorized disk reads and resolution to a watch snapshot.
use super::*;

pub(super) fn read_authorized_disk(state: &AppState, path: &Path) -> Result<DiskRead, String> {
    let normalized = ensure_authorized_watch_file_inner(state, path)?;
    match fs::metadata(&normalized) {
        Ok(metadata) if metadata.is_file() => {
            let opened = open_authorized_existing_file_inner(state, &normalized)?;
            let canonical = opened.path().to_path_buf();
            if canonical != normalized {
                return Err("Monitored file identity changed unexpectedly".to_string());
            }
            let workspace_authorization = opened.workspace_authorization().cloned();
            let (canonical, handle) = opened.into_parts();
            let file_identity = opened_file_platform_identity(&handle)
                .map_err(|_| "Monitored file identity could not be captured".to_string())?;
            let file_binding = Arc::new(
                handle
                    .try_clone()
                    .map_err(|_| "Monitored file binding could not be retained".to_string())?,
            );
            Ok(DiskRead::Present {
                file: open_authorized_file_response_from_handle(canonical, handle)?,
                file_identity,
                file_binding,
                workspace_authorization,
            })
        }
        Ok(_) => Err("Monitored path is no longer a regular file".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DiskRead::Missing),
        Err(_) => Err("Monitored file could not be inspected".to_string()),
    }
}

pub(super) fn resolve_disk_state(
    state: &AppState,
    context: &ReconcileContext,
) -> Result<ResolvedDisk, String> {
    if let DiskRead::Present {
        file,
        file_identity,
        file_binding,
        workspace_authorization,
    } = read_authorized_disk(state, &context.path)?
    {
        return Ok(ResolvedDisk::Present {
            file,
            file_identity,
            file_binding,
            workspace_authorization,
            reason: ActiveDocumentWatchReason::Changed,
            previous_path: None,
        });
    }

    let mut authorized_candidates = collect_rename_candidates(state, context);

    if authorized_candidates.len() == 1 {
        let new_path = authorized_candidates.pop().expect("one candidate exists");
        return resolve_renamed_disk_state(state, new_path, context);
    }

    Ok(ResolvedDisk::Missing)
}

fn collect_rename_candidates(
    state: &AppState,
    context: &ReconcileContext,
) -> Vec<PathBuf> {
    let mut authorized_candidates = Vec::<PathBuf>::new();
    for (old_path, candidate) in &context.rename_candidates {
        if old_path != &context.path {
            continue;
        }
        let Ok(canonical) = ensure_authorized_existing_file_inner(state, candidate) else {
            continue;
        };
        if canonical.parent() != Some(context.parent.as_path())
            || WorkspaceFileKind::classify(&canonical) != Some(context.file_kind)
        {
            continue;
        }
        if !authorized_candidates.contains(&canonical) {
            authorized_candidates.push(canonical);
        }
    }
    authorized_candidates
}

fn resolve_renamed_disk_state(
    state: &AppState,
    new_path: PathBuf,
    context: &ReconcileContext,
) -> Result<ResolvedDisk, String> {
    let (file, file_identity, file_binding, workspace_authorization) =
        match read_authorized_disk(state, &new_path)? {
            DiskRead::Present {
                file,
                file_identity,
                file_binding,
                workspace_authorization,
            } => (file, file_identity, file_binding, workspace_authorization),
            DiskRead::Missing => return Ok(ResolvedDisk::Missing),
        };
    Ok(ResolvedDisk::Present {
        file,
        file_identity,
        file_binding,
        workspace_authorization,
        reason: ActiveDocumentWatchReason::Renamed,
        previous_path: Some(context.path.clone()),
    })
}

pub(super) fn finalize_authorization_transition(
    state: &AppState,
    entry: &mut WatchEntry,
    resolved: &mut ResolvedDisk,
) -> Result<(), String> {
    match resolved {
        ResolvedDisk::Present {
            file,
            file_identity,
            file_binding,
            workspace_authorization,
            reason: ActiveDocumentWatchReason::Renamed,
            previous_path: Some(previous_path),
        } => {
            let new_path = PathBuf::from(&file.path);
            let expected_identity = entry
                .file_identity
                .as_deref()
                .ok_or_else(|| "Monitored file identity is unavailable".to_string())?;
            if !entry.file_binding.as_ref().is_some_and(|binding| {
                opened_file_platform_identity(binding)
                    .is_ok_and(|identity| identity == expected_identity)
            }) {
                return Err("Monitored file binding is unavailable".to_string());
            }
            if file_identity != expected_identity {
                return Err("Renamed document is not the monitored file".to_string());
            }
            let workspace_authorization = workspace_authorization.as_ref().ok_or_else(|| {
                "Renamed document is not bound to the authorized workspace".to_string()
            })?;
            relocate_authorized_path_prefix_with_workspace_authorization_inner(
                state,
                previous_path,
                &new_path,
                expected_identity,
                workspace_authorization,
            )?;
            entry.path = new_path;
            entry.file_binding = Some(file_binding.clone());
        }
        ResolvedDisk::Missing => {
            revoke_authorized_path_prefix_inner(state, &entry.path)?;
        }
        _ => {}
    }
    Ok(())
}
