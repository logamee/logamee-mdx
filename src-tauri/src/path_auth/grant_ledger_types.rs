//! Grant ledger types.
use super::*;

pub(crate) enum PreparedGrantMutation {
    Existing { key: GrantKey, origin: GrantOrigin },
    New { key: GrantKey, ledger: GrantLedger },
}
