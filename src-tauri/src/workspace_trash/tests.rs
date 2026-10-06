use std::path::PathBuf;

use super::testing::*;
use super::*;

#[test]
fn commits_file_only_when_missing_source_has_proven_recovery_receipt() {
    let (result, port) = classify(
        MoveToTrash::Placed {
            recovery_receipt: FakeReceipt(7),
        },
        SourceObservation::Missing,
        Some(PlacementVerification::Proven),
    );

    assert_eq!(
        result,
        TrashClassification::ConfirmedCommitted {
            recovery_receipt: FakeReceipt(7),
            warnings: vec![],
        }
    );
    assert_eq!(port.verified_receipts, vec![FakeReceipt(7)]);
}

#[test]
fn applies_the_same_contract_to_non_empty_directories() {
    let mut port = FakeTrashPort::new(
        MoveToTrash::Placed {
            recovery_receipt: FakeReceipt(11),
        },
        SourceObservation::Missing,
        Some(PlacementVerification::Proven),
    );

    let result = classify_trash(
        &mut port,
        Path::new("/authorized/workspace/non-empty"),
        TrashEntryKind::Directory,
    );

    assert!(matches!(
        result,
        TrashClassification::ConfirmedCommitted {
            recovery_receipt: FakeReceipt(11),
            ..
        }
    ));
    assert_eq!(
        port.moves,
        vec![(
            PathBuf::from("/authorized/workspace/non-empty"),
            TrashEntryKind::Directory
        )]
    );
}

#[test]
fn source_present_after_every_error_class_is_confirmed_not_committed() {
    for error in [
        FakeError::External,
        FakeError::ReadOnly,
        FakeError::Unavailable,
    ] {
        for move_result in [
            MoveToTrash::Rejected { error },
            MoveToTrash::PossiblyMoved {
                recovery_receipt: None,
                error,
            },
            MoveToTrash::PossiblyMoved {
                recovery_receipt: Some(FakeReceipt(13)),
                error,
            },
        ] {
            let (result, port) = classify(move_result, SourceObservation::Present, None);
            assert_eq!(
                result,
                TrashClassification::ConfirmedNotCommitted {
                    errors: vec![error]
                }
            );
            assert!(port.verified_receipts.is_empty());
        }
    }
}

#[test]
fn rejection_is_never_upgraded_from_source_absence_alone() {
    for error in [
        FakeError::External,
        FakeError::ReadOnly,
        FakeError::Unavailable,
    ] {
        let (result, port) = classify(
            MoveToTrash::Rejected { error },
            SourceObservation::Missing,
            None,
        );
        assert_eq!(
            result,
            TrashClassification::Indeterminate {
                recovery_receipt: None,
                errors: vec![error]
            }
        );
        assert!(port.verified_receipts.is_empty());
    }
}

#[test]
fn missing_source_without_receipt_is_indeterminate_after_post_move_error() {
    let (result, _) = classify(
        MoveToTrash::PossiblyMoved {
            recovery_receipt: None,
            error: FakeError::External,
        },
        SourceObservation::Missing,
        None,
    );
    assert_eq!(
        result,
        TrashClassification::Indeterminate {
            recovery_receipt: None,
            errors: vec![FakeError::External]
        }
    );
}

#[test]
fn proven_receipt_can_confirm_a_post_move_error() {
    let (result, _) = classify(
        MoveToTrash::PossiblyMoved {
            recovery_receipt: Some(FakeReceipt(17)),
            error: FakeError::External,
        },
        SourceObservation::Missing,
        Some(PlacementVerification::Proven),
    );
    assert_eq!(
        result,
        TrashClassification::ConfirmedCommitted {
            recovery_receipt: FakeReceipt(17),
            warnings: vec![FakeError::External]
        }
    );
}

#[test]
fn missing_mismatched_or_unobservable_recovery_is_indeterminate() {
    for move_result in [
        MoveToTrash::Placed {
            recovery_receipt: FakeReceipt(19),
        },
        MoveToTrash::PossiblyMoved {
            recovery_receipt: Some(FakeReceipt(19)),
            error: FakeError::External,
        },
    ] {
        for verification in [
            PlacementVerification::Missing,
            PlacementVerification::Mismatch,
            PlacementVerification::Unobservable {
                error: FakeError::Unavailable,
            },
        ] {
            let mut expected_errors = match &move_result {
                MoveToTrash::Placed { .. } => vec![],
                MoveToTrash::PossiblyMoved { error, .. } => vec![*error],
                MoveToTrash::Rejected { .. } => unreachable!(),
            };
            if let PlacementVerification::Unobservable { error } = &verification {
                expected_errors.push(*error);
            }
            let (result, _) = classify(
                move_result.clone(),
                SourceObservation::Missing,
                Some(verification),
            );
            assert_eq!(
                result,
                TrashClassification::Indeterminate {
                    recovery_receipt: Some(FakeReceipt(19)),
                    errors: expected_errors
                }
            );
        }
    }
}

#[test]
fn unobservable_source_is_always_indeterminate_and_skips_recovery_verification() {
    for (move_result, expected) in unobservable_source_cases() {
        let (result, port) = classify(
            move_result,
            SourceObservation::Unobservable {
                error: FakeError::Unavailable,
            },
            None,
        );
        assert_eq!(result, expected);
        assert!(port.verified_receipts.is_empty());
    }
}

fn unobservable_source_cases() -> [(
    MoveToTrash<FakeReceipt, FakeError>,
    TrashClassification<FakeReceipt, FakeError>,
); 4] {
    [
        (
            MoveToTrash::Placed {
                recovery_receipt: FakeReceipt(23),
            },
            TrashClassification::Indeterminate {
                recovery_receipt: Some(FakeReceipt(23)),
                errors: vec![FakeError::Unavailable],
            },
        ),
        (
            MoveToTrash::Rejected {
                error: FakeError::ReadOnly,
            },
            TrashClassification::Indeterminate {
                recovery_receipt: None,
                errors: vec![FakeError::ReadOnly, FakeError::Unavailable],
            },
        ),
        (
            MoveToTrash::PossiblyMoved {
                recovery_receipt: Some(FakeReceipt(29)),
                error: FakeError::External,
            },
            TrashClassification::Indeterminate {
                recovery_receipt: Some(FakeReceipt(29)),
                errors: vec![FakeError::External, FakeError::Unavailable],
            },
        ),
        (
            MoveToTrash::PossiblyMoved {
                recovery_receipt: None,
                error: FakeError::External,
            },
            TrashClassification::Indeterminate {
                recovery_receipt: None,
                errors: vec![FakeError::External, FakeError::Unavailable],
            },
        ),
    ]
}

#[test]
fn successful_move_with_source_still_present_is_indeterminate() {
    let (result, port) = classify(
        MoveToTrash::Placed {
            recovery_receipt: FakeReceipt(31),
        },
        SourceObservation::Present,
        None,
    );
    assert_eq!(
        result,
        TrashClassification::Indeterminate {
            recovery_receipt: Some(FakeReceipt(31)),
            errors: vec![]
        }
    );
    assert!(port.verified_receipts.is_empty());
}
