//! Core resolution pipeline shared by the resolve_open_intent command.
use super::{
    prepare_directory_open_inner, resolve_open_intent_with_ports_inner,
    resolve_session_restore_response, ResolvedOpenIntentInner, ResolvedOpenIntentResponse,
};
use crate::commands::{open_authorized_file_response, prepare_standalone_file_with_ports_inner};
use crate::open_intent::OpenIntentCoordinator;
use crate::state::AppState;

pub(super) fn resolve_open_intent_prepared(
    coordinator: &OpenIntentCoordinator,
    state: &AppState,
    owner: &str,
    intent_id: &str,
) -> Result<ResolvedOpenIntentResponse, String> {
    resolve_open_intent_with_ports_inner(
        coordinator,
        owner,
        intent_id,
        |path| {
            prepare_standalone_file_with_ports_inner(state, owner, path, |file| {
                open_authorized_file_response(file.to_path_buf())
            })
        },
        |path| prepare_directory_open_inner(state, owner, path, None),
    )
    .and_then(|resolved| match resolved {
        ResolvedOpenIntentInner::File(prepared) => Ok(ResolvedOpenIntentResponse::File { prepared }),
        ResolvedOpenIntentInner::Directory((workspace, workspace_open_receipt)) => {
            Ok(ResolvedOpenIntentResponse::Directory {
                workspace,
                workspace_open_receipt,
            })
        }
        ResolvedOpenIntentInner::SessionRestore => {
            resolve_session_restore_response(coordinator, state, owner)
        }
    })
}
