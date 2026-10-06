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
fn event_arriving_during_reconciliation_is_checked_before_publication() {
    use std::sync::Barrier;

    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let document = root.join("note.md");
    std::fs::write(&document, "needle").unwrap();
    let runtime = Arc::new(WorkspaceIndexRuntime::default());
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    let scope = lease_scope(&build);
    let event = || {
        Ok(
            notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )))
            .add_path(document.clone()),
        )
    };
    handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());

    let entered = Arc::new(Barrier::new(2));
    let proceed = Arc::new(Barrier::new(2));
    let publisher = Arc::clone(&runtime);
    let publisher_entered = Arc::clone(&entered);
    let publisher_proceed = Arc::clone(&proceed);
    let result = std::thread::spawn(move || {
        let (index, _) = index();
        let mut first_pass = true;
        publisher.publish_rebuild_with_reconcile_hook(&build, index, || {
            if first_pass {
                first_pass = false;
                publisher_entered.wait();
                publisher_proceed.wait();
            }
        })
    });

    entered.wait();
    handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());
    proceed.wait();

    assert!(result.join().unwrap().unwrap());
    assert!(runtime
        .is_result_current("workspace-1", &root, scope.generation)
        .unwrap());
}

#[test]
fn continuous_build_events_fail_closed_after_bounded_reconciliation() {
    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let document = root.join("note.md");
    std::fs::write(&document, "needle").unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    let scope = lease_scope(&build);
    let event = || {
        Ok(
            notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )))
            .add_path(document.clone()),
        )
    };
    handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());

    let (index, _) = index();
    assert!(!runtime
        .publish_rebuild_with_reconcile_hook(&build, index, || {
            handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, event());
        })
        .unwrap());
    assert!(build.cancellation.is_cancelled());
}

#[test]
fn publish_reconciles_buffered_file_and_directory_events() {
    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let document = root.join("note.md");
    std::fs::write(&document, "needle").unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    let scope = lease_scope(&build);

    for event in [
        notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
            .add_path(document),
        notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::Folder))
            .add_path(root.clone()),
    ] {
        handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, Ok(event));
    }

    let (index, _) = index();
    assert!(runtime.publish_rebuild(&build, index).unwrap());
    assert!(runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());
    let root_replay = || {
        Ok(
            notify::Event::new(notify::EventKind::Remove(notify::event::RemoveKind::Folder))
                .add_path(root.clone()),
        )
    };
    handle_native_watch_result(&Arc::downgrade(&runtime.state), &scope, root_replay());
    assert!(!runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());
}
