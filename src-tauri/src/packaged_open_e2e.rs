use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{State, WebviewWindow};

use crate::{
    open_intent::{
        OpenIntentCoordinator, OpenIntentEnqueueOutcome, OpenIntentPreviewTarget, OpenIntentSource,
    },
    path_auth::{AuthorizationEvidenceGrant, AuthorizationEvidenceSnapshot},
    state::AppState,
};

const GATE: &str = "packaged-native-open-e2e";
const SCHEMA: u32 = 2;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

static OBSERVER: OnceLock<Option<PackagedOpenObserver>> = OnceLock::new();

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EvidenceAuthorizationState {
    generation: u64,
    pending_file_receipts: usize,
    pending_workspace_receipts: usize,
    grants: Vec<AuthorizationEvidenceGrant>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationDelta {
    generation_before: u64,
    generation_after: u64,
    added: Vec<AuthorizationEvidenceGrant>,
    removed: Vec<AuthorizationEvidenceGrant>,
    pending_file_before: usize,
    pending_file_after: usize,
    pending_workspace_before: usize,
    pending_workspace_after: usize,
}

impl AuthorizationDelta {
    fn between(before: &EvidenceAuthorizationState, after: &EvidenceAuthorizationState) -> Self {
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

pub(crate) fn authorization_state(state: &AppState) -> Result<EvidenceAuthorizationState, String> {
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
struct ReceiptBinding {
    intent_id: String,
    step: String,
    target: String,
    receipt_kind: String,
}

#[derive(Default)]
struct ObserverState {
    events: Vec<Value>,
    intent_steps: HashMap<String, String>,
    intent_targets: HashMap<String, String>,
    receipts: HashMap<String, ReceiptBinding>,
    final_app: Option<Value>,
    final_authorization: Option<Value>,
    final_spellcheck: Option<Value>,
    queue_empty: bool,
    focus_control_recorded: bool,
    primary_started: bool,
    terminal: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlFile {
    schema: u32,
    focus: FocusControl,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusControl {
    intent_id: String,
    step: String,
    observed: bool,
    method: String,
    pid: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagedOpenConfigResponse {
    profile: String,
    unicode_rename_ready: bool,
    paths: PackagedOpenPaths,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackagedOpenPaths {
    primary_file: String,
    unicode_file: String,
    renamed_unicode_file: String,
    association_file: String,
    workspace_directory: String,
    stale_file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagedOpenAppEventRequest {
    #[serde(rename = "type")]
    event_type: String,
    intent_id: String,
    step: String,
    #[serde(default)]
    fields: Value,
}

struct PackagedOpenObserver {
    receipt_path: PathBuf,
    control_path: PathBuf,
    target: String,
    platform: String,
    run_id: String,
    run_attempt: String,
    commit: String,
    package_variant: String,
    profile: String,
    nonce_digest: String,
    primary_pid: u32,
    primary_file: PathBuf,
    unicode_file: PathBuf,
    renamed_unicode_file: PathBuf,
    association_file: PathBuf,
    workspace_directory: PathBuf,
    stale_file: PathBuf,
    state: Mutex<ObserverState>,
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn required_env(name: &str) -> Result<String, String> {
    optional_env(name).ok_or_else(|| format!("Packaged open E2E requires {name}"))
}

fn source_wire(source: OpenIntentSource) -> &'static str {
    match source {
        OpenIntentSource::StartupArguments => "startup_args",
        OpenIntentSource::SecondaryInstance => "secondary_instance",
        OpenIntentSource::OpenedEvent => "opened_event",
        OpenIntentSource::DragDrop => "drag_drop",
        OpenIntentSource::SessionRestore => "session_restore",
    }
}

fn sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(any(windows, test))]
const WINDOWS_VERBATIM_PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];

#[cfg(any(windows, test))]
fn windows_verbatim_drive_root_matches(root: &[u16], canonical: &[u16]) -> bool {
    const BACKSLASH: u16 = b'\\' as u16;

    let absolute_drive = root.first().copied().is_some_and(|value| {
        (b'A' as u16..=b'Z' as u16).contains(&value) || (b'a' as u16..=b'z' as u16).contains(&value)
    }) && root.get(1) == Some(&(b':' as u16))
        && root.get(2) == Some(&BACKSLASH);
    absolute_drive
        && canonical
            .strip_prefix(&WINDOWS_VERBATIM_PREFIX)
            .is_some_and(|remainder| remainder == root)
}

fn canonical_challenge_root(root: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(root)
        .map_err(|error| format!("Cannot canonicalize packaged open challenge: {error}"))?;
    if canonical == root {
        return Ok(root.to_path_buf());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        let root_wide = root.as_os_str().encode_wide().collect::<Vec<_>>();
        let canonical_wide = canonical.as_os_str().encode_wide().collect::<Vec<_>>();
        if windows_verbatim_drive_root_matches(&root_wide, &canonical_wide) {
            return Ok(root.to_path_buf());
        }
    }
    Err("Packaged open E2E challenge root is not canonical".to_string())
}

impl PackagedOpenObserver {
    fn from_environment() -> Result<Option<Self>, String> {
        let Some(root) = optional_env("MMD_PACKAGED_OPEN_E2E_CHALLENGE") else {
            return Ok(None);
        };
        let root = canonical_challenge_root(&PathBuf::from(root))?;
        let nonce = required_env("MMD_PACKAGED_OPEN_E2E_NONCE")?;
        if nonce.len() != 64 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Packaged open E2E nonce is invalid".to_string());
        }
        let fixtures = root.join("fixtures with spaces");
        let profile = required_env("MMD_PACKAGED_OPEN_E2E_PROFILE")?;
        if !matches!(profile.as_str(), "apply-reobserve" | "restore-cancel") {
            return Err("Packaged open E2E profile is invalid".to_string());
        }
        Ok(Some(Self {
            receipt_path: root.join("receipt.json"),
            control_path: root.join("control.json"),
            target: required_env("MMD_PACKAGED_OPEN_E2E_TARGET")?,
            platform: required_env("MMD_PACKAGED_OPEN_E2E_PLATFORM")?,
            run_id: required_env("MMD_PACKAGED_OPEN_E2E_RUN_ID")?,
            run_attempt: required_env("MMD_PACKAGED_OPEN_E2E_RUN_ATTEMPT")?,
            commit: required_env("MMD_PACKAGED_OPEN_E2E_COMMIT")?,
            package_variant: required_env("MMD_PACKAGED_OPEN_E2E_VARIANT")?,
            profile,
            nonce_digest: sha256(&nonce),
            primary_pid: std::process::id(),
            primary_file: fixtures.join("primary.md"),
            unicode_file: fixtures.join("文档 space.md"),
            renamed_unicode_file: fixtures.join("文档 renamed.md"),
            association_file: fixtures.join("association.md"),
            workspace_directory: fixtures.join("工作区 space"),
            stale_file: fixtures.join("removed stale.md"),
            state: Mutex::new(ObserverState::default()),
        }))
    }

    fn config(&self) -> PackagedOpenConfigResponse {
        PackagedOpenConfigResponse {
            profile: self.profile.clone(),
            unicode_rename_ready: matches!(
                fs::symlink_metadata(&self.unicode_file),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            ) && fs::symlink_metadata(&self.renamed_unicode_file)
                .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink()),
            paths: PackagedOpenPaths {
                primary_file: self.primary_file.to_string_lossy().into_owned(),
                unicode_file: self.unicode_file.to_string_lossy().into_owned(),
                renamed_unicode_file: self.renamed_unicode_file.to_string_lossy().into_owned(),
                association_file: self.association_file.to_string_lossy().into_owned(),
                workspace_directory: self.workspace_directory.to_string_lossy().into_owned(),
                stale_file: self.stale_file.to_string_lossy().into_owned(),
            },
        }
    }

    fn step_for(&self, path: &Path, outcome: &str) -> Option<&'static str> {
        if path == self.primary_file {
            Some("cli-primary")
        } else if path == self.unicode_file {
            Some(if outcome == "coalesced" {
                "cli-secondary-duplicate"
            } else {
                "cli-secondary-unicode"
            })
        } else if path == self.workspace_directory {
            Some("cli-directory")
        } else if path == self.stale_file {
            Some("cli-stale")
        } else if path == self.association_file {
            Some("file-association")
        } else {
            None
        }
    }

    fn append_event(
        &self,
        state: &mut ObserverState,
        actor: &str,
        event_type: &str,
        intent_id: &str,
        step: &str,
        fields: Value,
    ) {
        let mut event = match fields {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        event.insert("seq".to_string(), json!(state.events.len() + 1));
        event.insert("actor".to_string(), json!(actor));
        event.insert("type".to_string(), json!(event_type));
        event.insert("intentId".to_string(), json!(intent_id));
        event.insert("step".to_string(), json!(step));
        state.events.push(Value::Object(event));
    }

    fn collecting_receipt(&self, state: &ObserverState, status: &str) -> Value {
        json!({
            "schema": SCHEMA,
            "gate": GATE,
            "status": status,
            "identity": {
                "target": self.target,
                "platform": self.platform,
                "packageVariant": self.package_variant,
                "runId": self.run_id,
                "runAttempt": self.run_attempt,
                "commit": self.commit,
                "nonceDigest": self.nonce_digest,
                "profile": self.profile,
            },
            "primary": {
                "pid": self.primary_pid,
                "receiverPids": [self.primary_pid],
                "windowCount": 1,
            },
            "events": state.events,
            "final": if state.final_app.is_some() {
                json!({
                    "app": state.final_app,
                    "authorization": state.final_authorization,
                    "spellcheck": state.final_spellcheck,
                    "queueEmpty": state.queue_empty,
                })
            } else {
                Value::Null
            },
            "association": if self.package_variant == "appimage" {
                json!({
                    "status": "not_applicable",
                    "reason": "appimage-has-no-installed-association",
                })
            } else {
                json!({
                    "status": "verified",
                    "launcher": "platform-native",
                    "target": self.association_file.to_string_lossy(),
                })
            },
        })
    }

    fn write_receipt(&self, state: &ObserverState, status: &str) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&self.collecting_receipt(state, status))
            .map_err(|error| format!("Cannot serialize packaged open evidence: {error}"))?;
        fs::write(&self.receipt_path, bytes)
            .map_err(|error| format!("Cannot write packaged open evidence: {error}"))
    }

    fn record_enqueue(
        &self,
        coordinator: &OpenIntentCoordinator,
        result: &Result<OpenIntentEnqueueOutcome, crate::open_intent::OpenIntentEnqueueError>,
    ) {
        let Ok(outcome) = result else {
            return;
        };
        let head = outcome.head();
        let Some(preview) = coordinator.preview_for_id(head.id()) else {
            return;
        };
        let intent_id = head.id().to_wire();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return;
        }
        let is_primary_bootstrap = matches!(outcome, OpenIntentEnqueueOutcome::Enqueued(_))
            && matches!(preview.target(), OpenIntentPreviewTarget::CandidatePath(path) if
            if self.package_variant == "dmg" {
                head.source() == OpenIntentSource::OpenedEvent && path == &self.association_file
            } else {
                head.source() == OpenIntentSource::StartupArguments && path == &self.primary_file
            });
        if !state.primary_started && !is_primary_bootstrap {
            return;
        }
        if is_primary_bootstrap {
            state.primary_started = true;
        }
        match preview.target() {
            OpenIntentPreviewTarget::SessionRestore => {
                state
                    .intent_steps
                    .insert(intent_id.clone(), "session-restore".to_string());
                self.append_event(
                    &mut state,
                    "native",
                    "session_restore_queued",
                    &intent_id,
                    "session-restore",
                    json!({ "opaque": true }),
                );
            }
            OpenIntentPreviewTarget::CandidatePath(path) => {
                let outcome = match outcome {
                    OpenIntentEnqueueOutcome::Enqueued(_) => "enqueued",
                    OpenIntentEnqueueOutcome::Coalesced(_) => "coalesced",
                };
                let Some(step) = self.step_for(path, outcome) else {
                    return;
                };
                state
                    .intent_steps
                    .entry(intent_id.clone())
                    .or_insert_with(|| step.to_string());
                state
                    .intent_targets
                    .entry(intent_id.clone())
                    .or_insert_with(|| path.to_string_lossy().into_owned());
                self.append_event(
                    &mut state,
                    "native",
                    "native_delivery",
                    &intent_id,
                    step,
                    json!({
                        "source": source_wire(head.source()),
                        "target": path.to_string_lossy(),
                        "outcome": outcome,
                        "receiverPid": self.primary_pid,
                    }),
                );
            }
        }
        let _ = self.write_receipt(&state, "collecting");
    }

    fn step_and_target(&self, state: &ObserverState, intent_id: &str) -> (String, String) {
        (
            state
                .intent_steps
                .get(intent_id)
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            state
                .intent_targets
                .get(intent_id)
                .cloned()
                .unwrap_or_else(|| "session_restore".to_string()),
        )
    }

    fn record_backend_prepared(
        &self,
        intent_id: &str,
        target: &str,
        target_kind: &str,
        receipts: &[(&str, &str, &str)],
        before: &EvidenceAuthorizationState,
        after: &EvidenceAuthorizationState,
    ) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return;
        }
        let (step, _) = self.step_and_target(&state, intent_id);
        self.append_event(
            &mut state,
            "backend",
            "backend_reobserved",
            intent_id,
            &step,
            json!({ "target": target, "targetKind": target_kind }),
        );
        if receipts.is_empty() {
            self.append_event(
                &mut state,
                "backend",
                "backend_prepared",
                intent_id,
                &step,
                json!({
                    "receiptKind": "none",
                    "target": target,
                    "authorizationDelta": AuthorizationDelta::between(before, after),
                }),
            );
        }
        for (receipt_kind, receipt, receipt_target) in receipts {
            state.receipts.insert(
                (*receipt).to_string(),
                ReceiptBinding {
                    intent_id: intent_id.to_string(),
                    step: step.clone(),
                    target: (*receipt_target).to_string(),
                    receipt_kind: (*receipt_kind).to_string(),
                },
            );
            self.append_event(
                &mut state,
                "backend",
                "backend_prepared",
                intent_id,
                &step,
                json!({
                    "receiptKind": receipt_kind,
                    "receiptDigest": sha256(receipt),
                    "target": receipt_target,
                    "authorizationDelta": AuthorizationDelta::between(before, after),
                }),
            );
        }
        let _ = self.write_receipt(&state, "collecting");
    }

    fn record_backend_rejected(
        &self,
        intent_id: &str,
        reason: &str,
        before: &EvidenceAuthorizationState,
        after: &EvidenceAuthorizationState,
    ) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return;
        }
        let (step, target) = self.step_and_target(&state, intent_id);
        self.append_event(
            &mut state,
            "backend",
            "backend_rejected",
            intent_id,
            &step,
            json!({
                "target": target,
                "reason": reason,
                "authorizationDelta": AuthorizationDelta::between(before, after),
            }),
        );
        let _ = self.write_receipt(&state, "collecting");
    }

    fn record_receipt_settlement(
        &self,
        receipt: &str,
        settlement: &str,
        before: &EvidenceAuthorizationState,
        after: &EvidenceAuthorizationState,
    ) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return;
        }
        let Some(binding) = state.receipts.remove(receipt) else {
            return;
        };
        self.append_event(
            &mut state,
            "backend",
            "backend_receipt_settled",
            &binding.intent_id,
            &binding.step,
            json!({
                "receiptKind": binding.receipt_kind,
                "receiptDigest": sha256(receipt),
                "settlement": settlement,
                "target": binding.target,
                "authorizationDelta": AuthorizationDelta::between(before, after),
            }),
        );
        let _ = self.write_receipt(&state, "collecting");
    }

    fn record_focus_requested(&self, intent_id: &str, focus_type: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return;
        }
        let (step, _) = self.step_and_target(&state, intent_id);
        self.append_event(
            &mut state,
            "backend",
            focus_type,
            intent_id,
            &step,
            json!({}),
        );
        let _ = self.write_receipt(&state, "collecting");
    }

    fn record_intent_discarded(&self, intent_id: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return;
        }
        let (step, _) = self.step_and_target(&state, intent_id);
        self.append_event(
            &mut state,
            "backend",
            "backend_intent_discarded",
            intent_id,
            &step,
            json!({}),
        );
        let _ = self.write_receipt(&state, "collecting");
    }

    fn record_app_event(
        &self,
        request: PackagedOpenAppEventRequest,
        queue_empty: bool,
        authorization: &EvidenceAuthorizationState,
    ) -> Result<(), String> {
        if !matches!(
            request.event_type.as_str(),
            "app_activated"
                | "dirty_modal_opened"
                | "dirty_decision"
                | "app_applied"
                | "app_settled"
        ) {
            return Err("Packaged app event type is invalid".to_string());
        }
        if !request.intent_id.starts_with("open-intent-") || request.step.is_empty() {
            return Err("Packaged app event identity is invalid".to_string());
        }
        if !request.fields.is_object() {
            return Err("Packaged app event fields must be an object".to_string());
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return Ok(());
        }
        self.append_event(
            &mut state,
            "app",
            &request.event_type,
            &request.intent_id,
            &request.step,
            request.fields.clone(),
        );
        if request.event_type == "app_settled" && queue_empty {
            let fields = request
                .fields
                .as_object()
                .ok_or_else(|| "Packaged app settlement fields are invalid".to_string())?;
            let app = fields
                .get("app")
                .filter(|value| value.is_object())
                .cloned()
                .ok_or_else(|| "Packaged app settlement omitted final app state".to_string())?;
            let spellcheck = fields
                .get("spellcheck")
                .filter(|value| value.is_object())
                .cloned()
                .ok_or_else(|| "Packaged app settlement omitted spellcheck state".to_string())?;
            state.final_app = Some(app);
            state.final_authorization = Some(json!({
                "generation": authorization.generation,
                "pendingFileReceipts": authorization.pending_file_receipts,
                "pendingWorkspaceReceipts": authorization.pending_workspace_receipts,
                "grants": authorization.grants,
            }));
            state.final_spellcheck = Some(spellcheck);
            state.queue_empty = true;
        }
        self.write_receipt(&state, "collecting")
    }

    fn try_record_focus_control(&self, state: &mut ObserverState) -> Result<(), String> {
        if state.focus_control_recorded {
            return Ok(());
        }
        let control: ControlFile = match fs::read(&self.control_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("Packaged open control is invalid: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Cannot read packaged open control: {error}")),
        };
        if control.schema != SCHEMA
            || !control.focus.observed
            || control.focus.method != "platform-active-window-pid"
            || control.focus.pid != self.primary_pid
        {
            return Err("Packaged open focus evidence is invalid".to_string());
        }
        self.append_event(
            state,
            "runner",
            "focus_observed",
            &control.focus.intent_id,
            &control.focus.step,
            json!({
                "pid": control.focus.pid,
                "method": control.focus.method,
            }),
        );
        state.focus_control_recorded = true;
        Ok(())
    }

    fn expected_delivery_count(&self) -> usize {
        if self.package_variant == "appimage" {
            5
        } else {
            6
        }
    }

    fn try_finalize(&self) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return Ok(true);
        }
        self.try_record_focus_control(&mut state)?;
        let deliveries = state
            .events
            .iter()
            .filter(|event| event["type"] == "native_delivery")
            .count();
        let restore_queued = state
            .events
            .iter()
            .any(|event| event["type"] == "session_restore_queued");
        let pending_receipts_are_zero =
            state
                .final_authorization
                .as_ref()
                .is_some_and(|authorization| {
                    authorization["pendingFileReceipts"] == 0
                        && authorization["pendingWorkspaceReceipts"] == 0
                });
        if deliveries < self.expected_delivery_count()
            || !restore_queued
            || !state.focus_control_recorded
            || !state.queue_empty
            || !pending_receipts_are_zero
            || !state.receipts.is_empty()
        {
            self.write_receipt(&state, "collecting")?;
            return Ok(false);
        }
        self.write_receipt(&state, "passed")?;
        state.terminal = true;
        Ok(true)
    }

    fn write_failure(&self, error: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return;
        }
        let mut receipt = self
            .collecting_receipt(&state, "failed")
            .as_object()
            .cloned()
            .unwrap_or_default();
        receipt.insert("error".to_string(), json!(error));
        let _ = fs::write(
            &self.receipt_path,
            serde_json::to_vec_pretty(&Value::Object(receipt)).unwrap_or_default(),
        );
        state.terminal = true;
    }
}

fn observer() -> Option<&'static PackagedOpenObserver> {
    OBSERVER
        .get_or_init(|| PackagedOpenObserver::from_environment().unwrap_or(None))
        .as_ref()
}

pub(crate) fn initialize() {
    let Some(observer) = observer() else {
        return;
    };
    let observer: &'static PackagedOpenObserver = observer;
    thread::spawn(move || loop {
        match observer.try_finalize() {
            Ok(true) => break,
            Ok(false) => thread::sleep(POLL_INTERVAL),
            Err(error) => {
                observer.write_failure(&error);
                break;
            }
        }
    });
}

pub(crate) fn observe_enqueue(
    coordinator: &OpenIntentCoordinator,
    result: &Result<OpenIntentEnqueueOutcome, crate::open_intent::OpenIntentEnqueueError>,
) {
    if let Some(observer) = observer() {
        observer.record_enqueue(coordinator, result);
    }
}

pub(crate) fn observe_backend_prepared(
    intent_id: &str,
    target: &str,
    target_kind: &str,
    receipts: &[(&str, &str, &str)],
    before: &EvidenceAuthorizationState,
    after: &EvidenceAuthorizationState,
) {
    if let Some(observer) = observer() {
        observer.record_backend_prepared(intent_id, target, target_kind, receipts, before, after);
    }
}

pub(crate) fn observe_backend_rejected(
    intent_id: &str,
    reason: &str,
    before: &EvidenceAuthorizationState,
    after: &EvidenceAuthorizationState,
) {
    if let Some(observer) = observer() {
        observer.record_backend_rejected(intent_id, reason, before, after);
    }
}

pub(crate) fn observe_receipt_settlement(
    receipt: &str,
    settlement: &str,
    before: &EvidenceAuthorizationState,
    after: &EvidenceAuthorizationState,
) {
    if let Some(observer) = observer() {
        observer.record_receipt_settlement(receipt, settlement, before, after);
    }
}

pub(crate) fn observe_focus_requested(intent_id: &str, coalesced: bool) {
    if let Some(observer) = observer() {
        observer.record_focus_requested(
            intent_id,
            if coalesced {
                "focus_reasserted"
            } else {
                "focus_requested"
            },
        );
    }
}

pub(crate) fn observe_intent_discarded(intent_id: &str) {
    if let Some(observer) = observer() {
        observer.record_intent_discarded(intent_id);
    }
}

#[tauri::command]
pub(crate) fn get_packaged_open_e2e_config(
    window: WebviewWindow,
) -> Result<Option<PackagedOpenConfigResponse>, String> {
    if window.label() != "main" {
        return Err("Only the main window can inspect packaged open evidence".to_string());
    }
    Ok(observer().map(PackagedOpenObserver::config))
}

#[tauri::command]
pub(crate) fn record_packaged_open_app_event(
    event: PackagedOpenAppEventRequest,
    window: WebviewWindow,
    coordinator: State<'_, std::sync::Arc<OpenIntentCoordinator>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can record packaged open evidence".to_string());
    }
    let Some(observer) = observer() else {
        return Ok(());
    };
    let authorization = authorization_state(&state)?;
    observer.record_app_event(event, coordinator.peek_head().is_none(), &authorization)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_equivalent_windows_verbatim_drive_root() {
        let dos = r"C:\Users\runneradmin\AppData\Local\Temp\challenge";
        let verbatim = r"\\?\C:\Users\runneradmin\AppData\Local\Temp\challenge";

        assert!(windows_verbatim_drive_root_matches(
            &dos.encode_utf16().collect::<Vec<_>>(),
            &verbatim.encode_utf16().collect::<Vec<_>>(),
        ));
        assert!(!windows_verbatim_drive_root_matches(
            &dos.encode_utf16().collect::<Vec<_>>(),
            &r"\\?\c:\Users\runneradmin\AppData\Local\Temp\challenge"
                .encode_utf16()
                .collect::<Vec<_>>(),
        ));
        assert!(!windows_verbatim_drive_root_matches(
            &r"\\server\share\challenge"
                .encode_utf16()
                .collect::<Vec<_>>(),
            &r"\\?\UNC\server\share\challenge"
                .encode_utf16()
                .collect::<Vec<_>>(),
        ));
        assert!(!windows_verbatim_drive_root_matches(
            &dos.encode_utf16().collect::<Vec<_>>(),
            &r"\\?\C:\Users\runneradmin\AppData\Local\Temp\other"
                .encode_utf16()
                .collect::<Vec<_>>(),
        ));
    }

    #[cfg(windows)]
    #[test]
    fn accepts_a_canonical_windows_temp_root_without_the_verbatim_prefix() {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let directory = tempfile::tempdir().unwrap();
        let canonical = fs::canonicalize(directory.path()).unwrap();
        let canonical_wide = canonical.as_os_str().encode_wide().collect::<Vec<_>>();
        let dos_wide = canonical_wide
            .strip_prefix(&WINDOWS_VERBATIM_PREFIX)
            .expect("Windows canonicalization must return a verbatim drive path");
        let dos = PathBuf::from(OsString::from_wide(dos_wide));

        assert_ne!(canonical, dos);
        assert_eq!(canonical_challenge_root(&dos).unwrap(), dos);
    }

    fn test_observer(root: &Path, package_variant: &str, profile: &str) -> PackagedOpenObserver {
        let fixtures = root.join("fixtures with spaces");
        PackagedOpenObserver {
            receipt_path: root.join("receipt.json"),
            control_path: root.join("control.json"),
            target: "target".to_string(),
            platform: "linux".to_string(),
            run_id: "run".to_string(),
            run_attempt: "1".to_string(),
            commit: "commit".to_string(),
            package_variant: package_variant.to_string(),
            profile: profile.to_string(),
            nonce_digest: "0".repeat(64),
            primary_pid: 7,
            primary_file: fixtures.join("primary.md"),
            unicode_file: fixtures.join("文档 space.md"),
            renamed_unicode_file: fixtures.join("文档 renamed.md"),
            association_file: fixtures.join("association.md"),
            workspace_directory: fixtures.join("工作区 space"),
            stale_file: fixtures.join("removed stale.md"),
            state: Mutex::new(ObserverState::default()),
        }
    }

    fn empty_authorization() -> EvidenceAuthorizationState {
        EvidenceAuthorizationState {
            generation: 0,
            pending_file_receipts: 0,
            pending_workspace_receipts: 0,
            grants: Vec::new(),
        }
    }

    #[test]
    fn config_reports_when_the_unicode_target_has_been_renamed() {
        let directory = tempfile::tempdir().unwrap();
        let observer = test_observer(directory.path(), "deb", "apply-reobserve");
        fs::create_dir_all(observer.unicode_file.parent().unwrap()).unwrap();
        fs::write(&observer.unicode_file, "# unicode\n").unwrap();

        assert!(!observer.config().unicode_rename_ready);

        fs::rename(&observer.unicode_file, &observer.renamed_unicode_file).unwrap();

        assert!(observer.config().unicode_rename_ready);
    }

    #[test]
    fn records_native_events_with_one_rust_owned_monotonic_sequence() {
        let directory = tempfile::tempdir().unwrap();
        let observer = test_observer(directory.path(), "deb", "apply-reobserve");
        let coordinator = OpenIntentCoordinator::default();
        let primary = coordinator.enqueue_path(
            observer.primary_file.clone(),
            OpenIntentSource::StartupArguments,
        );
        observer.record_enqueue(&coordinator, &primary);
        observer.record_enqueue(&coordinator, &coordinator.enqueue_session_restore());

        let state = observer.state.lock().unwrap();
        assert_eq!(state.events[0]["seq"], 1);
        assert_eq!(state.events[0]["type"], "native_delivery");
        assert_eq!(state.events[1]["seq"], 2);
        assert_eq!(state.events[1]["type"], "session_restore_queued");
        assert_eq!(state.events[1]["opaque"], true);
        assert!(state.events[1].get("target").is_none());
    }

    #[test]
    fn backend_preparation_maps_opaque_receipt_to_exact_settlement_delta() {
        let directory = tempfile::tempdir().unwrap();
        let observer = test_observer(directory.path(), "deb", "apply-reobserve");
        let coordinator = OpenIntentCoordinator::default();
        let result = coordinator.enqueue_path(
            observer.primary_file.clone(),
            OpenIntentSource::StartupArguments,
        );
        let intent_id = result.as_ref().unwrap().head().id().to_wire();
        observer.record_enqueue(&coordinator, &result);
        let before = empty_authorization();
        let mut after = before.clone();
        after.pending_file_receipts = 1;
        observer.record_backend_prepared(
            &intent_id,
            &observer.primary_file.to_string_lossy(),
            "file",
            &[("file", "aabbcc", &observer.primary_file.to_string_lossy())],
            &before,
            &after,
        );
        observer.record_receipt_settlement("aabbcc", "discarded", &after, &before);

        let state = observer.state.lock().unwrap();
        let prepared = state
            .events
            .iter()
            .find(|event| event["type"] == "backend_prepared")
            .unwrap();
        assert_eq!(
            prepared["target"],
            observer.primary_file.to_string_lossy().as_ref()
        );
        let settled = state.events.last().unwrap();
        assert_eq!(settled["type"], "backend_receipt_settled");
        assert_eq!(settled["receiptKind"], "file");
        assert_eq!(
            settled["target"],
            observer.primary_file.to_string_lossy().as_ref()
        );
        assert_eq!(settled["settlement"], "discarded");
        assert_eq!(settled["authorizationDelta"]["pendingFileBefore"], 1);
        assert_eq!(settled["authorizationDelta"]["pendingFileAfter"], 0);
        assert_ne!(settled["receiptDigest"], "aabbcc");
    }

    #[test]
    fn authorization_delta_preserves_aggregated_shared_parent_count() {
        let directory = tempfile::tempdir().unwrap();
        let first_document = directory.path().join("first.md");
        let second_document = directory.path().join("second.md");
        fs::write(&first_document, "# first").unwrap();
        fs::write(&second_document, "# second").unwrap();
        let state = AppState::default();

        state
            .file_authorization()
            .with_prepared_open_document_grant(&first_document, |grant| {
                grant.apply()?;
                Ok(())
            })
            .unwrap();
        let first_snapshot = state.file_authorization().evidence_snapshot().unwrap();
        let first = EvidenceAuthorizationState {
            generation: first_snapshot.generation,
            pending_file_receipts: 0,
            pending_workspace_receipts: first_snapshot.pending_workspace_receipts,
            grants: first_snapshot.grants,
        };
        state
            .file_authorization()
            .with_prepared_open_document_grant(&second_document, |grant| {
                grant.apply()?;
                Ok(())
            })
            .unwrap();
        let second_snapshot = state.file_authorization().evidence_snapshot().unwrap();
        let second = EvidenceAuthorizationState {
            generation: second_snapshot.generation,
            pending_file_receipts: 0,
            pending_workspace_receipts: second_snapshot.pending_workspace_receipts,
            grants: second_snapshot.grants,
        };
        let delta = AuthorizationDelta::between(&first, &second);

        assert_eq!((first.generation, second.generation), (1, 2));
        assert_eq!((delta.generation_before, delta.generation_after), (1, 2));
        let shared_parent = second
            .grants
            .iter()
            .find(|grant| grant.kind == "internal_asset" && grant.origin == "open_document")
            .unwrap();
        assert_eq!(
            second
                .grants
                .iter()
                .filter(|grant| {
                    grant.kind == "internal_asset" && grant.origin == "open_document"
                })
                .count(),
            1
        );
        assert_eq!(shared_parent.count, 2);
        assert!(delta.removed.iter().any(|grant| {
            grant.kind == "internal_asset" && grant.origin == "open_document" && grant.count == 1
        }));
        assert!(delta.added.iter().any(|grant| {
            grant.kind == "internal_asset" && grant.origin == "open_document" && grant.count == 2
        }));
        assert!(delta.added.iter().any(|grant| {
            grant.kind == "exact_rw"
                && grant.path
                    == fs::canonicalize(&second_document)
                        .unwrap()
                        .to_string_lossy()
                && grant.count == 1
        }));
    }

    #[test]
    fn app_settlement_uses_rust_queue_and_authorization_for_final_state() {
        let directory = tempfile::tempdir().unwrap();
        let observer = test_observer(directory.path(), "deb", "restore-cancel");
        let authorization = empty_authorization();
        observer
            .record_app_event(
                PackagedOpenAppEventRequest {
                    event_type: "app_settled".to_string(),
                    intent_id: "open-intent-1".to_string(),
                    step: "session-restore".to_string(),
                    fields: json!({
                        "status": "cancelled",
                        "app": {
                            "activeFile": null,
                            "workspaceRoot": null,
                            "workspaceToken": null,
                            "authorityStatus": "committed",
                            "dirty": false,
                        },
                        "spellcheck": {
                            "realEditorCount": 1,
                            "enabledRealEditorCount": 1,
                            "enabledNonEditorCount": 0,
                            "dictionaryConsistency": "not_claimed",
                        },
                    }),
                },
                true,
                &authorization,
            )
            .unwrap();

        let state = observer.state.lock().unwrap();
        assert!(state.queue_empty);
        assert_eq!(
            state.final_authorization.as_ref().unwrap()["pendingFileReceipts"],
            0
        );
        assert_eq!(
            state.final_app.as_ref().unwrap()["authorityStatus"],
            "committed"
        );
    }

    #[test]
    fn unresolved_internal_receipt_binding_prevents_finalization() {
        let directory = tempfile::tempdir().unwrap();
        let observer = test_observer(directory.path(), "appimage", "apply-reobserve");
        let mut state = observer.state.lock().unwrap();
        for index in 0..observer.expected_delivery_count() {
            state.events.push(json!({
                "seq": index + 1,
                "type": "native_delivery",
            }));
        }
        let restore_sequence = state.events.len() + 1;
        state.events.push(json!({
            "seq": restore_sequence,
            "type": "session_restore_queued",
        }));
        state.receipts.insert(
            "opaque-receipt".to_string(),
            ReceiptBinding {
                intent_id: "open-intent-1".to_string(),
                step: "cli-primary".to_string(),
                target: observer.primary_file.to_string_lossy().into_owned(),
                receipt_kind: "file".to_string(),
            },
        );
        state.final_app = Some(json!({ "authorityStatus": "committed" }));
        state.final_authorization = Some(json!({
            "pendingFileReceipts": 0,
            "pendingWorkspaceReceipts": 0,
        }));
        state.queue_empty = true;
        state.focus_control_recorded = true;
        drop(state);

        assert!(!observer.try_finalize().unwrap());
    }
}
