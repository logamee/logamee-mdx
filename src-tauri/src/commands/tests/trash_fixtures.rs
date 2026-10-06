//! Scripted trash-port fixtures.
pub(crate) use super::fixtures::*;

pub(crate) fn scripted_trash(mode: ScriptedTrashMode, recovery_path: PathBuf) -> ScriptedTrashPort {
    ScriptedTrashPort {
        mode,
        recovery_path,
        calls: 0,
    }
}
