//! Observer receipt-settlement, workspace and app-event records.

use super::*;
impl PackagedOpenObserver {
    pub(super) fn record_receipt_settlement(
        &self,
        receipt: &str,
        settlement: &str,
        before: &EvidenceAuthorizationState,
        after: &EvidenceAuthorizationState,
    ) {
        let Some(mut state) = self.locked_active_state() else {
            return;
        };
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

    pub(super) fn record_workspace_published(
        &self,
        intent_id: &str,
        target: &str,
        before: &EvidenceAuthorizationState,
        after: &EvidenceAuthorizationState,
    ) {
        let Some(mut state) = self.locked_active_state() else {
            return;
        };
        let (step, _) = self.step_and_target(&state, intent_id);
        if step == "unknown" {
            return;
        }
        self.append_event(
            &mut state,
            "backend",
            "backend_workspace_published",
            intent_id,
            &step,
            json!({
                "target": target,
                "authorizationDelta": AuthorizationDelta::between(before, after),
            }),
        );
        let _ = self.write_receipt(&state, "collecting");
    }
    pub(super) fn record_focus_requested(&self, intent_id: &str, focus_type: &str) {
        let Some(mut state) = self.locked_active_state() else {
            return;
        };
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

    pub(super) fn record_intent_discarded(&self, intent_id: &str) {
        let Some(mut state) = self.locked_active_state() else {
            return;
        };
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

    pub(super) fn record_app_event(
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
}
