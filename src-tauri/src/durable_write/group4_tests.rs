use super::test_prelude::*;
use super::*;

#[test]
fn temp_creation_failure_preserves_original_without_abandoned_staging() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("settings.json");
    fs::write(&destination, b"old-image").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let result = durable_write_inner(
        &destination,
        b"new-image",
        &exact(&expected),
        Some(DurableWriteFault::TempCreate),
    );

    assert!(result.is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"old-image");
    assert!(staged_files(directory.path()).is_empty());
}
#[test]
fn post_replace_observation_failure_is_indeterminate_and_retains_exact_before_image() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("settings.json");
    fs::write(&destination, b"old-image").unwrap();
    let expected = capture_file_version(&destination).unwrap().unwrap();

    let outcome = durable_write_inner(
        &destination,
        b"new-image",
        &exact(&expected),
        Some(DurableWriteFault::Observe),
    )
    .unwrap();

    let DurableWriteOutcome::Indeterminate { recovery_paths, .. } = outcome else {
        panic!("observation failure must be indeterminate");
    };
    assert_eq!(fs::read(&destination).unwrap(), b"new-image");
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"old-image")));
    assert!(recovery_paths
        .iter()
        .any(|path| fs::read(path).ok().as_deref() == Some(b"new-image")));
}
#[test]
fn concurrent_writers_with_one_expected_version_report_only_one_confirmed_commit() {
    for round in 0..16 {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("settings.json");
        fs::write(&destination, b"initial").unwrap();
        let expected = Arc::new(capture_file_version(&destination).unwrap().unwrap());
        let barrier = Arc::new(Barrier::new(6));
        let mut joins = Vec::new();
        for index in 0..6 {
            let destination = destination.clone();
            let expected = expected.clone();
            let barrier = barrier.clone();
            joins.push(thread::spawn(move || {
                let bytes = format!("writer-{round}-{index}").into_bytes();
                barrier.wait();
                durable_write(&destination, &bytes, &exact(&expected)).unwrap()
            }));
        }
        let outcomes = joins
            .into_iter()
            .map(|join| join.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(
                    outcome,
                    DurableWriteOutcome::ConfirmedCommitted { .. }
                ))
                .count(),
            1,
            "round {round}"
        );
        assert!(fs::read_to_string(destination)
            .unwrap()
            .starts_with(&format!("writer-{round}-")));
        for outcome in outcomes {
            match outcome {
                DurableWriteOutcome::Conflict { recovery_path, .. } => {
                    assert!(recovery_path.exists());
                }
                DurableWriteOutcome::Indeterminate { recovery_paths, .. } => {
                    assert!(recovery_paths.iter().all(|path| path.exists()));
                }
                DurableWriteOutcome::ConfirmedNotCommitted { recovery_paths, .. } => {
                    assert!(recovery_paths.iter().all(|path| path.exists()));
                }
                DurableWriteOutcome::ConfirmedCommitted { .. } => {}
            }
        }
    }
}
