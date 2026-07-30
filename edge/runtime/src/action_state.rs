//! 动作状态机（与 @irobot/action-protocol 一致）。终态不可变。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionState {
    Proposed,
    Validating,
    PendingApproval,
    Accepted,
    Executing,
    CancelRequested,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
    Rejected,
}

impl ActionState {
    /// 五个终态，进入后不可再转移。
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ActionState::Succeeded
                | ActionState::Failed
                | ActionState::Cancelled
                | ActionState::Expired
                | ActionState::Rejected
        )
    }

    /// 合法后继状态；未列出的转移一律非法（fail-closed）。
    fn allowed_next(self) -> &'static [ActionState] {
        use ActionState::*;
        match self {
            Proposed => &[Validating],
            Validating => &[Rejected, PendingApproval, Accepted],
            PendingApproval => &[Accepted, Rejected, Expired],
            Accepted => &[Executing, Expired],
            Executing => &[Succeeded, Failed, CancelRequested],
            CancelRequested => &[Cancelled, Failed],
            Succeeded | Failed | Cancelled | Expired | Rejected => &[],
        }
    }

    pub fn can_transition(self, to: ActionState) -> bool {
        self.allowed_next().contains(&to)
    }

    /// 线级名称（与 TS ActionState 一致，用于 Edge 进程协议）。
    pub fn wire(self) -> &'static str {
        use ActionState::*;
        match self {
            Proposed => "PROPOSED",
            Validating => "VALIDATING",
            PendingApproval => "PENDING_APPROVAL",
            Accepted => "ACCEPTED",
            Executing => "EXECUTING",
            CancelRequested => "CANCEL_REQUESTED",
            Succeeded => "SUCCEEDED",
            Failed => "FAILED",
            Cancelled => "CANCELLED",
            Expired => "EXPIRED",
            Rejected => "REJECTED",
        }
    }

    pub fn parse_wire(s: &str) -> Option<ActionState> {
        use ActionState::*;
        Some(match s {
            "PROPOSED" => Proposed,
            "VALIDATING" => Validating,
            "PENDING_APPROVAL" => PendingApproval,
            "ACCEPTED" => Accepted,
            "EXECUTING" => Executing,
            "CANCEL_REQUESTED" => CancelRequested,
            "SUCCEEDED" => Succeeded,
            "FAILED" => Failed,
            "CANCELLED" => Cancelled,
            "EXPIRED" => Expired,
            "REJECTED" => Rejected,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IllegalTransition {
    pub from: ActionState,
    pub to: ActionState,
}

impl fmt::Display for IllegalTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "illegal state transition: {:?} -> {:?}", self.from, self.to)
    }
}
impl std::error::Error for IllegalTransition {}

/// 应用一次转移；终态出发或非法转移均 Err（fail-closed，所有落账前的强制守卫）。
pub fn apply_transition(
    from: ActionState,
    to: ActionState,
) -> Result<ActionState, IllegalTransition> {
    if from.is_terminal() || !from.can_transition(to) {
        return Err(IllegalTransition { from, to });
    }
    Ok(to)
}

#[cfg(test)]
mod tests {
    use super::ActionState::*;
    use super::*;

    #[test]
    fn terminals_are_immutable() {
        for t in [Succeeded, Failed, Cancelled, Expired, Rejected] {
            assert!(t.is_terminal());
            assert!(apply_transition(t, Executing).is_err());
        }
    }

    #[test]
    fn happy_path_is_legal() {
        let path = [Proposed, Validating, Accepted, Executing, Succeeded];
        for w in path.windows(2) {
            assert_eq!(apply_transition(w[0], w[1]).unwrap(), w[1]);
        }
    }

    #[test]
    fn cancel_path_needs_cancel_requested() {
        assert!(apply_transition(Executing, Cancelled).is_err());
        assert_eq!(apply_transition(Executing, CancelRequested).unwrap(), CancelRequested);
        assert_eq!(apply_transition(CancelRequested, Cancelled).unwrap(), Cancelled);
    }

    #[test]
    fn cannot_skip_validation() {
        assert!(apply_transition(Proposed, Executing).is_err());
        assert!(apply_transition(Proposed, Accepted).is_err());
    }
}
