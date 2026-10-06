//! Observer enqueue/backend preparation records.

use super::*;
impl PackagedOpenObserver {
    pub(super) fn record_enqueue(
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
        let Some(mut state) = self.locked_active_state() else {
            return;
        };
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

    pub(super) fn step_and_target(&self, state: &ObserverState, intent_id: &str) -> (String, String) {
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

    pub(super) fn record_backend_prepared(
        &self,
        intent_id: &str,
        target: &str,
        target_kind: &str,
        receipts: &[(&str, &str, &str)],
        before: &EvidenceAuthorizationState,
        after: &EvidenceAuthorizationState,
    ) {
        let Some(mut state) = self.locked_active_state() else {
            return;
        };
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

    pub(super) fn record_backend_rejected(
        &self,
        intent_id: &str,
        reason: &str,
        before: &EvidenceAuthorizationState,
        after: &EvidenceAuthorizationState,
    ) {
        let Some(mut state) = self.locked_active_state() else {
            return;
        };
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
}
