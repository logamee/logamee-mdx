use super::*;
use crate::workspace_index::{build_index, BuildReport, IndexDocument, IndexLimits};
use std::sync::atomic::{AtomicUsize, Ordering};
use tempfile::tempdir;
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
fn publish_rejects_buffered_events_that_do_not_match_the_rebuilt_index() {
    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let document = root.join("note.md");
    std::fs::write(&document, "changed").unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    let scope = lease_scope(&build);
    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        Ok(
            notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )))
            .add_path(document),
        ),
    );

    let (index, _) = index();
    assert!(!runtime.publish_rebuild(&build, index).unwrap());
    assert!(build.cancellation.is_cancelled());
}

#[test]
fn stale_watcher_events_preserve_matching_published_content_but_real_changes_invalidate() {
    let (_directory, root, document, runtime, build, scope) = stale_markdown_watch_context();
    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        directory_metadata_event(&root, &root.join("nested")),
    );
    assert!(!build.cancellation.is_cancelled());

    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        Ok(
            notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
                .add_path(document.clone()),
        ),
    );
    assert!(!build.cancellation.is_cancelled());

    let (index, _) = index();
    assert!(runtime.publish_rebuild(&build, index).unwrap());

    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        document_content_event(&document),
    );
    assert!(runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());

    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        directory_metadata_event(&root, &root.join("nested")),
    );
    assert!(runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());

    std::fs::write(&document, "changed").unwrap();
    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        document_content_event(&document),
    );
    assert!(!runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());
}

fn stale_markdown_watch_context() -> (
    tempfile::TempDir,
    PathBuf,
    PathBuf,
    WorkspaceIndexRuntime,
    WorkspaceIndexLease,
    WorkspaceIndexScope,
) {
    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let document = root.join("note.md");
    std::fs::create_dir(root.join("nested")).unwrap();
    std::fs::write(&document, "needle").unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    let scope = lease_scope(&build);
    (directory, root, document, runtime, build, scope)
}

fn directory_metadata_event(root: &Path, nested: &Path) -> Result<notify::Event, notify::Error> {
    Ok(notify::Event::new(notify::EventKind::Modify(
        notify::event::ModifyKind::Metadata(notify::event::MetadataKind::Any),
    ))
    .add_path(root.to_path_buf())
    .add_path(nested.to_path_buf()))
}

fn document_content_event(document: &Path) -> Result<notify::Event, notify::Error> {
    Ok(
        notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Content,
        )))
        .add_path(document.to_path_buf()),
    )
}

#[test]
fn rename_to_non_markdown_invalidates_the_stale_markdown_source() {
    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let source = root.join("note.md");
    let destination = root.join("note.txt");
    std::fs::write(&source, "needle").unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    let scope = lease_scope(&build);
    let (index, _) = index();
    assert!(runtime.publish_rebuild(&build, index).unwrap());
    std::fs::rename(source, &destination).unwrap();

    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        Ok(
            notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::To,
            )))
            .add_path(destination),
        ),
    );

    assert!(!runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());
}

#[test]
fn unknown_published_event_kinds_fail_closed() {
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
    let (index, _) = index();
    assert!(runtime.publish_rebuild(&build, index).unwrap());

    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        Ok(notify::Event::new(notify::EventKind::Any).add_path(document)),
    );

    assert!(!runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());
}

#[test]
fn published_directory_events_fail_closed_without_repeated_full_scans() {
    let directory = tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::write(root.join("note.md"), "needle").unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    let scope = lease_scope(&build);
    let (index, _) = index();
    assert!(runtime.publish_rebuild(&build, index).unwrap());

    for _ in 0..10_000 {
        handle_native_watch_result(
            &Arc::downgrade(&runtime.state),
            &scope,
            Ok(
                notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::Folder))
                    .add_path(root.clone()),
            ),
        );
    }

    assert!(!runtime
        .is_result_current("workspace-1", &root, build.generation)
        .unwrap());
}

#[test]
fn replacing_the_workspace_root_object_prevents_publication() {
    let directory = tempdir().unwrap();
    let root = directory.path().join("workspace");
    let displaced = directory.path().join("displaced");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note.md"), "needle").unwrap();
    let root = root.canonicalize().unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", &root, "build-1")
        .unwrap();
    let watcher = runtime.state.lock().unwrap().watcher.take();
    stop_watch(watcher);
    std::fs::rename(&root, displaced).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note.md"), "needle").unwrap();

    let (index, _) = index();
    assert!(!runtime.publish_rebuild(&build, index).unwrap());
    assert!(build.cancellation.is_cancelled());
}

#[test]
fn watcher_errors_invalidate_and_cancel_the_bound_generation() {
    let directory = tempdir().unwrap();
    let runtime = WorkspaceIndexRuntime::default();
    let build = runtime
        .begin_rebuild("workspace-1", directory.path(), "build-1")
        .unwrap();
    let scope = lease_scope(&build);

    handle_native_watch_result(
        &Arc::downgrade(&runtime.state),
        &scope,
        Err(notify::Error::generic("injected watcher overflow")),
    );

    assert!(build.cancellation.is_cancelled());
    assert_eq!(
        runtime
            .current_generation("workspace-1", directory.path())
            .unwrap(),
        Some(build.generation + 1)
    );
}

struct CountingWatchHandle(Arc<AtomicUsize>);

impl WatchHandlePort for CountingWatchHandle {
    fn stop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn discard_all_stops_the_bound_workspace_watcher() {
    let runtime = WorkspaceIndexRuntime::default();
    let stopped = Arc::new(AtomicUsize::new(0));
    runtime.install_watch_for_test(Box::new(CountingWatchHandle(Arc::clone(&stopped))));

    runtime.discard_all();

    assert_eq!(stopped.load(Ordering::SeqCst), 1);
}
