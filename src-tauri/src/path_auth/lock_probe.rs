//! Test probe tracing lock acquisition order.
use std::cell::RefCell;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LockEvent {
    RecentRuntimeAcquired,
    RecentRuntimeReleased,
    RecentFs2Acquired,
    RecentFs2Released,
    AuthorizationAcquired,
    AuthorizationReleased,
    HtmlSitesAcquired,
    HtmlSitesReleased,
}

#[derive(Default)]
struct TraceState {
    events: Vec<LockEvent>,
    recent_runtime_depth: usize,
    recent_fs2_depth: usize,
    authorization_depth: usize,
    html_sites_depth: usize,
    violation: Option<&'static str>,
}

thread_local! {
    static TRACE: RefCell<Option<TraceState>> = const { RefCell::new(None) };
}

pub(crate) fn trace<T>(operation: impl FnOnce() -> T) -> (T, Vec<LockEvent>) {
    TRACE.with(|trace| {
        assert!(
            trace.borrow().is_none(),
            "lock-order traces cannot be nested"
        );
        *trace.borrow_mut() = Some(TraceState::default());
    });
    let result = operation();
    let state = TRACE.with(|trace| {
        trace
            .borrow_mut()
            .take()
            .expect("lock-order trace is active")
    });
    assert_eq!(state.authorization_depth, 0);
    assert_eq!(state.html_sites_depth, 0);
    assert_eq!(state.recent_runtime_depth, 0);
    assert_eq!(state.recent_fs2_depth, 0);
    assert!(
        state.violation.is_none(),
        "{}",
        state.violation.unwrap_or("")
    );
    (result, state.events)
}

pub(crate) fn authorization_acquired() {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(state) = trace.as_mut() else {
            return;
        };
        if state.html_sites_depth > 0 {
            state.violation = Some("authorization acquired while HTML sites guard was held");
        }
        if state.recent_runtime_depth > 0 && state.recent_fs2_depth == 0 {
            state.violation = Some("authorization acquired before fs2 while MRU was held");
        }
        state.authorization_depth += 1;
        state.events.push(LockEvent::AuthorizationAcquired);
    });
}

pub(crate) fn authorization_released() {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(state) = trace.as_mut() else {
            return;
        };
        state.authorization_depth -= 1;
        state.events.push(LockEvent::AuthorizationReleased);
    });
}

pub(crate) fn html_sites_acquired() {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(state) = trace.as_mut() else {
            return;
        };
        if state.authorization_depth > 0 {
            state.violation = Some("HTML sites guard acquired while authorization was held");
        }
        if state.recent_runtime_depth > 0 {
            state.violation = Some("HTML sites guard acquired while MRU was held");
        }
        state.html_sites_depth += 1;
        state.events.push(LockEvent::HtmlSitesAcquired);
    });
}

pub(crate) fn html_sites_released() {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(state) = trace.as_mut() else {
            return;
        };
        state.html_sites_depth -= 1;
        state.events.push(LockEvent::HtmlSitesReleased);
    });
}

pub(crate) fn recent_runtime_acquired() {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(state) = trace.as_mut() else {
            return;
        };
        if state.authorization_depth > 0
            || state.html_sites_depth > 0
            || state.recent_fs2_depth > 0
        {
            state.violation = Some("MRU acquired while a later-order lock was held");
        }
        state.recent_runtime_depth += 1;
        state.events.push(LockEvent::RecentRuntimeAcquired);
    });
}

pub(crate) fn recent_runtime_released() {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(state) = trace.as_mut() else {
            return;
        };
        if state.recent_fs2_depth > 0 || state.authorization_depth > 0 {
            state.violation = Some("MRU released before later-order locks");
        }
        state.recent_runtime_depth -= 1;
        state.events.push(LockEvent::RecentRuntimeReleased);
    });
}

pub(crate) fn recent_fs2_acquired() {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(state) = trace.as_mut() else {
            return;
        };
        if state.recent_runtime_depth == 0
            || state.authorization_depth > 0
            || state.html_sites_depth > 0
        {
            state.violation = Some("fs2 acquired outside the MRU lock order");
        }
        state.recent_fs2_depth += 1;
        state.events.push(LockEvent::RecentFs2Acquired);
    });
}

pub(crate) fn recent_fs2_released() {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(state) = trace.as_mut() else {
            return;
        };
        if state.authorization_depth > 0 {
            state.violation = Some("fs2 released before authorization");
        }
        state.recent_fs2_depth -= 1;
        state.events.push(LockEvent::RecentFs2Released);
    });
}

pub(crate) fn assert_no_locks_held() {
    TRACE.with(|trace| {
        let trace = trace.borrow();
        let state = trace.as_ref().expect("lock-order trace is active");
        assert_eq!(state.authorization_depth, 0);
        assert_eq!(state.html_sites_depth, 0);
        assert_eq!(state.recent_runtime_depth, 0);
        assert_eq!(state.recent_fs2_depth, 0);
    });
}

pub(crate) fn assert_authorization_held_without_html_sites() {
    TRACE.with(|trace| {
        let trace = trace.borrow();
        let state = trace.as_ref().expect("lock-order trace is active");
        assert_eq!(state.authorization_depth, 1);
        assert_eq!(state.html_sites_depth, 0);
    });
}
