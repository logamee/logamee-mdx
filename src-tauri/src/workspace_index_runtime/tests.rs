use crate::workspace_index::{build_index, BuildReport, IndexDocument, IndexLimits};
use tempfile::tempdir;
use super::*;
fn index() -> (WorkspaceIndex, BuildReport) {
    build_index(
        vec![IndexDocument {
            relative_path: "note.md".to_string(),
            content: "needle".to_string(),
        }],
        IndexLimits::default(),
        &CancellationToken::new(),
    )
    .completed()
    .unwrap()
}


#[test]
fn a_rebuild_generation_cannot_publish_after_its_scope_is_invalidated() {
    let runtime = WorkspaceIndexRuntime::default();
    let directory = tempdir().unwrap();
    let root = directory.path();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let (index, _) = index();

    runtime.invalidate("workspace-1", &root).unwrap();

    assert!(!runtime.publish_rebuild(&build, index).unwrap());
    assert!(!runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());
}

#[test]
fn a_new_rebuild_discards_the_previous_generation_and_cancels_its_work() {
    let runtime = WorkspaceIndexRuntime::default();
    let directory = tempdir().unwrap();
    let root = directory.path();
    let first = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let (first_index, _) = index();
    assert!(runtime.publish_rebuild(&first, first_index).unwrap());

    let second = runtime
        .begin_rebuild("workspace-1", &root, "build-2")
        .unwrap();

    assert!(first.cancellation.is_cancelled());
    assert!(!runtime
        .is_result_current("workspace-1", &root, second.generation)
        .unwrap());
    assert!(second.generation > first.generation);
}

#[test]
fn discard_all_does_not_reuse_a_generation_for_the_same_workspace() {
    let runtime = WorkspaceIndexRuntime::default();
    let directory = tempdir().unwrap();
    let first = runtime
        .begin_rebuild("workspace-1", directory.path(), "build-1")
        .unwrap();

    runtime.discard_all();
    let second = runtime
        .begin_rebuild("workspace-1", directory.path(), "build-2")
        .unwrap();

    assert!(second.generation > first.generation);
}

#[test]
fn rebuild_generation_advances_past_every_invalidation_generation() {
    let runtime = WorkspaceIndexRuntime::default();
    let directory = tempdir().unwrap();
    let first = runtime
        .begin_rebuild("workspace-1", directory.path(), "build-1")
        .unwrap();

    assert!(runtime.invalidate("workspace-1", directory.path()).unwrap());
    let invalidated_generation = runtime
        .current_generation("workspace-1", directory.path())
        .unwrap()
        .unwrap();
    let second = runtime
        .begin_rebuild("workspace-1", directory.path(), "build-2")
        .unwrap();

    assert!(invalidated_generation > first.generation);
    assert!(second.generation > invalidated_generation);
}

#[test]
fn query_leases_are_rejected_after_discard() {
    let runtime = WorkspaceIndexRuntime::default();
    let directory = tempdir().unwrap();
    let root = directory.path();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let (index, _) = index();
    assert!(runtime.publish_rebuild(&build, index).unwrap());
    let query = runtime
        .begin_query("workspace-1", &root, "query-1")
        .unwrap();

    assert!(runtime.discard("workspace-1", &root).unwrap());
    assert!(!runtime.is_current(&query.lease).unwrap());
    assert!(query.lease.cancellation.is_cancelled());
}

#[test]
fn an_expired_lease_cannot_publish_or_remain_current() {
    let runtime = WorkspaceIndexRuntime::default();
    let directory = tempdir().unwrap();
    let root = directory.path();
    let mut build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    build.deadline = Instant::now();
    let (index, _) = index();

    assert!(build.is_cancelled());
    assert!(!runtime.publish_rebuild(&build, index).unwrap());
    assert!(!runtime.is_current(&build).unwrap());
}

#[test]
fn a_late_callback_from_a_replaced_watcher_cannot_invalidate_the_new_binding() {
    let directory = tempdir().unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let first = runtime
        .begin_rebuild("workspace-1", directory.path(), "build-1")
        .unwrap();
    let second = runtime
        .begin_rebuild("workspace-1", directory.path(), "build-2")
        .unwrap();
    let stale_scope = lease_scope(&first);

    invalidate_exact_binding(&runtime.state, &stale_scope, false);

    assert!(!second.cancellation.is_cancelled());
    assert_eq!(
        runtime
            .current_generation("workspace-1", directory.path())
            .unwrap(),
        Some(second.generation)
    );
}

#[test]
fn watcher_events_are_buffered_before_publication_but_errors_invalidate() {
    let directory = tempdir().unwrap();

    for (result, should_invalidate) in [
        (
            Ok(notify::Event::new(notify::EventKind::Access(
                notify::event::AccessKind::Any,
            ))),
            false,
        ),
        (
            Ok(
                notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any))
                    .add_path(directory.path().to_path_buf()),
            ),
            false,
        ),
        (
            Ok(notify::Event::new(notify::EventKind::Any)
                .add_path(directory.path().to_path_buf())),
            false,
        ),
        (
            Err(notify::Error::generic("injected watcher overflow")),
            true,
        ),
    ] {
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-1")
            .unwrap();
        let scope = lease_scope(&build);

        handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, result);

        assert_eq!(build.cancellation.is_cancelled(), should_invalidate);
        assert_eq!(
            runtime
                .current_generation("workspace-1", directory.path())
                .unwrap(),
            Some(build.generation + u64::from(should_invalidate))
        );
    }
}

#[test]
fn watcher_rescan_always_cancels_the_build() {
    for kind in [
        notify::EventKind::Access(notify::event::AccessKind::Any),
        notify::EventKind::Modify(notify::event::ModifyKind::Metadata(
            notify::event::MetadataKind::Any,
        )),
    ] {
        let directory = tempdir().unwrap();
        let runtime = WorkspaceIndexRuntime::default();
        let build = runtime
            .begin_rebuild("workspace-1", directory.path(), "build-1")
            .unwrap();
        let watcher = runtime.state.lock().unwrap().watcher.take();
        stop_watch(watcher);
        let scope = lease_scope(&build);

        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            Ok(notify::Event::new(kind).set_flag(notify::event::Flag::Rescan)),
        );

        assert!(build.cancellation.is_cancelled());
    }
}

#[test]
fn watcher_event_storm_coalesces_into_one_bounded_reconciliation() {
    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let document = root.join("note.md");
    std::fs::write(&document, "needle").unwrap();
    std::fs::write(
        root.join("oversized.md"),
        vec![b'x'; IndexLimits::default().max_file_bytes + 1],
    )
    .unwrap();
    std::fs::write(root.join("invalid.md"), [0xff, 0xfe]).unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    let scope = lease_scope(&build);

    for _ in 0..10_000 {
        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            Ok(
                notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )))
                .add_path(document.clone()),
            ),
        );
    }

    assert!(!build.cancellation.is_cancelled());
    let (index, _) = index();
    assert!(runtime.publish_rebuild(&build, index).unwrap());
}
