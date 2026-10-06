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
        SourceObservation::Missing => classify_missing_source(port, recovery_receipt, errors),
    }
}

fn classify_missing_source<P: TrashPort>(
    port: &mut P,
    recovery_receipt: Option<P::RecoveryReceipt>,
    errors: Vec<P::Error>,
) -> TrashClassification<P::RecoveryReceipt, P::Error> {
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
            let mut errors = errors;
            errors.push(error);
            TrashClassification::Indeterminate {
                recovery_receipt: Some(recovery_receipt),
                errors,
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::{collections::VecDeque, path::PathBuf};

    use super::*;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) struct FakeReceipt(pub(crate) u64);

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum FakeError {
        External,
        ReadOnly,
        Unavailable,
    }

    pub(crate) struct FakeTrashPort {
        pub(crate) move_result: Option<MoveToTrash<FakeReceipt, FakeError>>,
        pub(crate) source_observations: VecDeque<SourceObservation<FakeError>>,
        pub(crate) placement_verifications: VecDeque<PlacementVerification<FakeError>>,
        pub(crate) moves: Vec<(PathBuf, TrashEntryKind)>,
        pub(crate) verified_receipts: Vec<FakeReceipt>,
    }

    impl FakeTrashPort {
        pub(crate) fn new(
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

    pub(crate) fn classify(
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
}

#[cfg(test)]
mod tests;
