//! Windows Shell file-operation progress sink implementation.
use super::*;

impl IFileOperationProgressSink_Impl for ProgressSink_Impl {
    fn StartOperations(&self) -> WinResult<()> {
        Ok(())
    }
    fn FinishOperations(&self, result: HRESULT) -> WinResult<()> {
        if result.is_err() {
            self.state
                .lock()
                .map_err(|_| ::windows::core::Error::from(E_FAIL))? // platform-audit: allow (platform-gated trash transport)
                .record_error(format!("FinishOperations failed: {result:?}"));
        }
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> WinResult<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> WinResult<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> WinResult<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> WinResult<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> WinResult<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> WinResult<()> {
        Ok(())
    }
    fn PreDeleteItem(&self, _: u32, item: Ref<'_, IShellItem>) -> WinResult<()> {
        let validation = match item.as_ref() {
            Some(item) => unsafe { shell_item_path(item) }
                .map_err(|error| {
                    NativeTrashError::new("resolve Windows shell item before deletion", error)
                })
                .and_then(|item_path| {
                    validate_pre_delete_identity(&item_path, &self.expected_source_identity)
                }),
            None => Err(NativeTrashError::new(
                "resolve Windows shell item before deletion",
                "Shell did not provide the item queued for deletion",
            )),
        };
        record_pre_delete_validation(&self.state, validation)
    }
    fn PostDeleteItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        result: HRESULT,
        recycled: Ref<'_, IShellItem>,
    ) -> WinResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ::windows::core::Error::from(E_FAIL))?; // platform-audit: allow (platform-gated trash transport)
        if result.is_err() {
            state.record_error(format!("PostDeleteItem failed: {result:?}"));
        }
        if let Some(recycled) = recycled.as_ref() {
            match unsafe { shell_item_path(recycled) } {
                Ok(path) => state.destination = Some(path),
                Err(error) => state.record_error(error),
            }
        } else if state.post_delete_error.is_none() {
            state.record_error("PostDeleteItem returned no recycled item");
        }
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> WinResult<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> WinResult<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> WinResult<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> WinResult<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> WinResult<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> WinResult<()> {
        Ok(())
    }
}
