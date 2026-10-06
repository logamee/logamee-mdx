use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EvidenceAuthorizationState {
    pub(crate) generation: u64,
    pub(crate) pending_file_receipts: usize,
    pub(crate) pending_workspace_receipts: usize,
    pub(crate) grants: Vec<AuthorizationEvidenceGrant>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthorizationDelta {
    pub(super) generation_before: u64,
    pub(super) generation_after: u64,
    pub(super) added: Vec<AuthorizationEvidenceGrant>,
    pub(super) removed: Vec<AuthorizationEvidenceGrant>,
    pub(super) pending_file_before: usize,
    pub(super) pending_file_after: usize,
    pub(super) pending_workspace_before: usize,
    pub(super) pending_workspace_after: usize,
}

impl AuthorizationDelta {
    pub(super) fn between(
        before: &EvidenceAuthorizationState,
        after: &EvidenceAuthorizationState,
    ) -> Self {
        let before_grants = before.grants.iter().cloned().collect::<HashSet<_>>();
        let after_grants = after.grants.iter().cloned().collect::<HashSet<_>>();
        let mut added = after_grants
            .difference(&before_grants)
            .cloned()
            .collect::<Vec<_>>();
        let mut removed = before_grants
            .difference(&after_grants)
            .cloned()
            .collect::<Vec<_>>();
        sort_grants(&mut added);
        sort_grants(&mut removed);
        Self {
            generation_before: before.generation,
            generation_after: after.generation,
            added,
            removed,
            pending_file_before: before.pending_file_receipts,
            pending_file_after: after.pending_file_receipts,
            pending_workspace_before: before.pending_workspace_receipts,
            pending_workspace_after: after.pending_workspace_receipts,
        }
    }
}

fn sort_grants(grants: &mut [AuthorizationEvidenceGrant]) {
    grants.sort_by(|left, right| {
        (
            left.kind,
            left.path.as_str(),
            left.origin,
            left.status,
            left.count,
        )
            .cmp(&(
                right.kind,
                right.path.as_str(),
                right.origin,
                right.status,
                right.count,
            ))
    });
}

/// Reads the complete producer state while holding the shared evidence boundary.
#[cfg(test)]
pub(crate) fn authorization_state(state: &AppState) -> Result<EvidenceAuthorizationState, String> {
    let _evidence_guard = state.packaged_evidence_lock()?;
    authorization_state_locked(state)
}

/// Reads the complete producer state for a caller that already owns the boundary lock.
pub(crate) fn authorization_state_locked(
    state: &AppState,
) -> Result<EvidenceAuthorizationState, String> {
    let AuthorizationEvidenceSnapshot {
        generation,
        pending_workspace_receipts,
        grants,
    } = state.file_authorization().evidence_snapshot()?;
    Ok(EvidenceAuthorizationState {
        generation,
        pending_file_receipts: state.recent_files()?.pending_receipt_count_for_evidence()?,
        pending_workspace_receipts,
        grants,
    })
}

#[derive(Clone, Debug)]
pub(super) struct ReceiptBinding {
    pub(super) intent_id: String,
    pub(super) step: String,
    pub(super) target: String,
    pub(super) receipt_kind: String,
}

#[derive(Default)]
pub(super) struct ObserverState {
    pub(super) events: Vec<Value>,
    pub(super) intent_steps: HashMap<String, String>,
    pub(super) intent_targets: HashMap<String, String>,
    pub(super) receipts: HashMap<String, ReceiptBinding>,
    pub(super) final_app: Option<Value>,
    pub(super) final_authorization: Option<Value>,
    pub(super) final_spellcheck: Option<Value>,
    pub(super) queue_empty: bool,
    pub(super) focus_control_recorded: bool,
    pub(super) primary_started: bool,
    pub(super) terminal: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ControlFile {
    pub(super) schema: u32,
    pub(super) focus: FocusControl,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FocusControl {
    pub(super) intent_id: String,
    pub(super) step: String,
    pub(super) observed: bool,
    pub(super) method: String,
    pub(super) pid: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagedOpenConfigResponse {
    pub(super) profile: String,
    pub(super) unicode_rename_ready: bool,
    pub(super) paths: PackagedOpenPaths,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PackagedOpenPaths {
    pub(super) primary_file: String,
    pub(super) unicode_file: String,
    pub(super) renamed_unicode_file: String,
    pub(super) association_file: String,
    pub(super) workspace_directory: String,
    pub(super) stale_file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagedOpenAppEventRequest {
    #[serde(rename = "type")]
    pub(super) event_type: String,
    pub(super) intent_id: String,
    pub(super) step: String,
    #[serde(default)]
    pub(super) fields: Value,
}

pub(crate) struct PackagedOpenObserver {
    pub(super) receipt_path: PathBuf,
    pub(super) control_path: PathBuf,
    pub(super) target: String,
    pub(super) platform: String,
    pub(super) run_id: String,
    pub(super) run_attempt: String,
    pub(super) commit: String,
    pub(super) package_variant: String,
    pub(super) profile: String,
    pub(super) nonce_digest: String,
    pub(super) primary_pid: u32,
    pub(super) primary_file: PathBuf,
    pub(super) unicode_file: PathBuf,
    pub(super) renamed_unicode_file: PathBuf,
    pub(super) association_file: PathBuf,
    pub(super) workspace_directory: PathBuf,
    pub(super) stale_file: PathBuf,
    pub(super) state: Mutex<ObserverState>,
}
