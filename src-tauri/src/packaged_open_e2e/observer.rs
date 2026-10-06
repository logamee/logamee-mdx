//! Observer lifecycle, config, receipts and finalization.

use super::*;
impl PackagedOpenObserver {
    pub(super) fn locked_active_state(&self) -> Option<std::sync::MutexGuard<'_, ObserverState>> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal {
            return None;
        }
        Some(state)
    }
}

impl PackagedOpenObserver {
    pub(super) fn from_environment() -> Result<Option<Self>, String> {
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

    pub(super) fn config(&self) -> PackagedOpenConfigResponse {
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

    pub(super) fn step_for(&self, path: &Path, outcome: &str) -> Option<&'static str> {
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

    pub(super) fn append_event(
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

    pub(super) fn write_receipt(&self, state: &ObserverState, status: &str) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&self.collecting_receipt(state, status))
            .map_err(|error| format!("Cannot serialize packaged open evidence: {error}"))?;
        fs::write(&self.receipt_path, bytes)
            .map_err(|error| format!("Cannot write packaged open evidence: {error}"))
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

    pub(super) fn expected_delivery_count(&self) -> usize {
        if self.package_variant == "appimage" {
            5
        } else {
            6
        }
    }

    pub(super) fn try_finalize(&self) -> Result<bool, String> {
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

    pub(super) fn write_failure(&self, error: &str) {
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
