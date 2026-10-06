use super::test_prelude::*;
use super::*;

#[test]
fn terminal_outcomes_are_owner_bound_capped_at_sixty_four_and_expire_at_two_minutes() {
    let mut runtime = RecentRuntime::default();
    let now = Duration::from_secs(10);

    runtime
        .issue(
            "main",
            absolute_path("docs/pending.md"),
            None,
            now,
            opaque_id(1),
            opaque_id(2),
        )
        .unwrap();
    assert_eq!(
        runtime.status("main", &opaque_id(2), now),
        super::RuntimeOpenStatus::Pending
    );
    assert_eq!(
        runtime.status("editor", &opaque_id(2), now),
        super::RuntimeOpenStatus::Unknown
    );

    for index in 0..65 {
        runtime
            .retain_outcome(
                "main",
                opaque_id(100 + index),
                TerminalOpenOutcome::NotCommitted {
                    message: format!("failure-{index}"),
                },
                now,
            )
            .unwrap();
    }

    assert_eq!(runtime.outcome_len(), 64);
    assert_eq!(
        runtime.status("main", &opaque_id(100), now),
        super::RuntimeOpenStatus::Unknown
    );
    assert_eq!(
        runtime.status("main", &opaque_id(164), now),
        super::RuntimeOpenStatus::NotCommitted {
            message: "failure-64".to_string(),
        }
    );
    assert_eq!(
        runtime.status("editor", &opaque_id(164), now),
        super::RuntimeOpenStatus::Unknown
    );

    runtime.prune(Duration::from_secs(130));
    assert_eq!(runtime.outcome_len(), 0);
}
