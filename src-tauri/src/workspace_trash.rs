use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TrashEntryKind {
    File,
    Directory,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MoveToTrash<R, E> {
    Placed {
        recovery_receipt: R,
    },
    Rejected {
        error: E,
    },
    PossiblyMoved {
        recovery_receipt: Option<R>,
        error: E,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SourceObservation<E> {
    Present,
    Missing,
    Unobservable { error: E },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PlacementVerification<E> {
    Proven,
    Missing,
    Mismatch,
    Unobservable { error: E },
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum TrashClassification<R, E> {
    ConfirmedCommitted {
        recovery_receipt: R,
        warnings: Vec<E>,
    },
    ConfirmedNotCommitted {
        errors: Vec<E>,
    },
    Indeterminate {
        recovery_receipt: Option<R>,
        errors: Vec<E>,
    },
}

pub(crate) trait TrashPort {
    type RecoveryReceipt;
    type Error;

    fn move_to_trash(
        &mut self,
        source: &Path,
        kind: TrashEntryKind,
    ) -> MoveToTrash<Self::RecoveryReceipt, Self::Error>;

    fn observe_source(&mut self, source: &Path) -> SourceObservation<Self::Error>;

    fn verify_placement(
        &mut self,
        recovery_receipt: &Self::RecoveryReceipt,
    ) -> PlacementVerification<Self::Error>;
}

pub(crate) fn classify_trash<P: TrashPort>(
    port: &mut P,
    source: &Path,
    kind: TrashEntryKind,
) -> TrashClassification<P::RecoveryReceipt, P::Error> {
    let (recovery_receipt, mut errors) = match port.move_to_trash(source, kind) {
        MoveToTrash::Placed { recovery_receipt } => (Some(recovery_receipt), Vec::new()),
        MoveToTrash::Rejected { error } => (None, vec![error]),
        MoveToTrash::PossiblyMoved {
            recovery_receipt,
            error,
        } => (recovery_receipt, vec![error]),
    };

    match port.observe_source(source) {
        SourceObservation::Present if !errors.is_empty() => {
            TrashClassification::ConfirmedNotCommitted { errors }
        }
        SourceObservation::Present => TrashClassification::Indeterminate {
            recovery_receipt,
            errors,
        },
        SourceObservation::Unobservable { error } => {
            errors.push(error);
            TrashClassification::Indeterminate {
                recovery_receipt,
                errors,
            }
        }
        SourceObservation::Missing => {
            let Some(recovery_receipt) = recovery_receipt else {
                return TrashClassification::Indeterminate {
                    recovery_receipt: None,
                    errors,
                };
            };
            match port.verify_placement(&recovery_receipt) {
                PlacementVerification::Proven => TrashClassification::ConfirmedCommitted {
                    recovery_receipt,
                    warnings: errors,
                },
                PlacementVerification::Missing | PlacementVerification::Mismatch => {
                    TrashClassification::Indeterminate {
                        recovery_receipt: Some(recovery_receipt),
                        errors,
                    }
                }
                PlacementVerification::Unobservable { error } => {
                    errors.push(error);
                    TrashClassification::Indeterminate {
                        recovery_receipt: Some(recovery_receipt),
                        errors,
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, path::PathBuf};

    use super::*;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct FakeReceipt(u64);

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum FakeError {
        External,
        ReadOnly,
        Unavailable,
    }

    struct FakeTrashPort {
        move_result: Option<MoveToTrash<FakeReceipt, FakeError>>,
        source_observations: VecDeque<SourceObservation<FakeError>>,
        placement_verifications: VecDeque<PlacementVerification<FakeError>>,
        moves: Vec<(PathBuf, TrashEntryKind)>,
        verified_receipts: Vec<FakeReceipt>,
    }

    impl FakeTrashPort {
        fn new(
            move_result: MoveToTrash<FakeReceipt, FakeError>,
            source: SourceObservation<FakeError>,
            verification: Option<PlacementVerification<FakeError>>,
        ) -> Self {
            Self {
                move_result: Some(move_result),
                source_observations: VecDeque::from([source]),
                placement_verifications: verification.into_iter().collect(),
                moves: Vec::new(),
                verified_receipts: Vec::new(),
            }
        }
    }

    impl TrashPort for FakeTrashPort {
        type RecoveryReceipt = FakeReceipt;
        type Error = FakeError;

        fn move_to_trash(
            &mut self,
            source: &Path,
            kind: TrashEntryKind,
        ) -> MoveToTrash<Self::RecoveryReceipt, Self::Error> {
            self.moves.push((source.to_path_buf(), kind));
            self.move_result.take().expect("move called once")
        }

        fn observe_source(&mut self, _source: &Path) -> SourceObservation<Self::Error> {
            self.source_observations
                .pop_front()
                .expect("source observed once")
        }

        fn verify_placement(
            &mut self,
            recovery_receipt: &Self::RecoveryReceipt,
        ) -> PlacementVerification<Self::Error> {
            self.verified_receipts.push(*recovery_receipt);
            self.placement_verifications
                .pop_front()
                .expect("placement verified when a receipt can prove a missing source")
        }
    }

    fn classify(
        move_result: MoveToTrash<FakeReceipt, FakeError>,
        source: SourceObservation<FakeError>,
        verification: Option<PlacementVerification<FakeError>>,
    ) -> (TrashClassification<FakeReceipt, FakeError>, FakeTrashPort) {
        let mut port = FakeTrashPort::new(move_result, source, verification);
        let result = classify_trash(
            &mut port,
            Path::new("/authorized/workspace/entry"),
            TrashEntryKind::File,
        );
        (result, port)
    }

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
        let cases = [
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
        ];

        for (move_result, expected) in cases {
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
}
