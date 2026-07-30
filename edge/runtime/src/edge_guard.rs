//! Edge 准入守卫 + Action Journal。把 §8.2 的安全不变量在 Edge 侧强制执行
//! （架构：Edge 是权威安全层，即便上游 Orchestrator 已判定，Edge 仍二次守卫）。
//!
//! 强制：幂等去重（恰好一次效果）、租约 fencing、并发互斥、deadline、S4 禁止。

use crate::action_state::ActionState;
use crate::safety::SafetyClass;
use std::collections::{HashMap, HashSet};

/// 一次动作准入请求（由 Action Envelope 归一而来）。
#[derive(Debug, Clone)]
pub struct ActionRequest {
    pub command_id: String,
    pub idempotency_key: String,
    pub capability_id: String,
    pub safety_class: SafetyClass,
    pub concurrency_key: String,
    /// 期限（毫秒时间戳）；None 表示不设期限。
    pub deadline_ms: Option<u64>,
    pub lease_epoch: Option<u64>,
    pub expected_state_version: Option<u64>,
}

/// 准入结果。
#[derive(Debug, Clone, PartialEq)]
pub enum Admission {
    /// 通过：已占用 concurrency_key，调用方须在终态后 complete() 释放。
    Accepted,
    /// 幂等命中：重放缓存终态，绝不二次执行。
    Deduplicated { cached: ActionState },
    /// 拒绝：附原因。
    Rejected { reason: String },
}

/// Action Journal 条目：每次准入/终态一条审计。
#[derive(Debug, Clone)]
pub struct JournalEntry {
    pub command_id: String,
    pub idempotency_key: String,
    pub capability_id: String,
    pub final_state: ActionState,
    pub reason: Option<String>,
    pub lease_epoch: Option<u64>,
    pub deduplicated: bool,
    pub at_ms: u64,
}

#[derive(Default)]
pub struct EdgeGuard {
    idempotency: HashMap<String, ActionState>,
    device_lease_epoch: u64,
    busy_concurrency: HashSet<String>,
    journal: Vec<JournalEntry>,
}

impl EdgeGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn journal(&self) -> &[JournalEntry] {
        &self.journal
    }

    pub fn device_lease_epoch(&self) -> u64 {
        self.device_lease_epoch
    }

    /// 准入判定。顺序：幂等 → S4 → deadline → 租约 → 并发。拒绝/去重即时落账。
    pub fn admit(&mut self, req: &ActionRequest, now_ms: u64) -> Admission {
        // 幂等：命中缓存终态 → 重放，不执行（安全不变量 §4.1#6）。
        if let Some(&cached) = self.idempotency.get(&req.idempotency_key) {
            if cached.is_terminal() {
                self.record(req, cached, Some("deduplicated".into()), true, now_ms);
                return Admission::Deduplicated { cached };
            }
        }

        // S4 或不可提案等级：从入口拒绝。
        if !req.safety_class.agent_may_propose() {
            return self.reject(req, "safety class forbids agent proposal", now_ms);
        }

        // 期限：过期不执行（§8.2）。
        if let Some(dl) = req.deadline_ms {
            if dl < now_ms {
                return self.reject(req, "deadline passed", now_ms);
            }
        }

        // 租约 fencing：较旧 epoch 一律拒绝（§9.2）。
        if let Some(epoch) = req.lease_epoch {
            if epoch < self.device_lease_epoch {
                return self.reject(
                    req,
                    &format!("stale lease epoch {} < {}", epoch, self.device_lease_epoch),
                    now_ms,
                );
            }
            self.device_lease_epoch = self.device_lease_epoch.max(epoch);
        }

        // 并发互斥：同一 concurrency_key 已有写动作则拒绝（§8.2）。
        if self.busy_concurrency.contains(&req.concurrency_key) {
            return self.reject(
                req,
                &format!("concurrency key '{}' busy", req.concurrency_key),
                now_ms,
            );
        }

        self.busy_concurrency.insert(req.concurrency_key.clone());
        Admission::Accepted
    }

    /// 终态收尾：释放并发键、缓存幂等结果、落账。仅对 Accepted 的请求调用。
    pub fn complete(&mut self, req: &ActionRequest, final_state: ActionState, now_ms: u64) {
        debug_assert!(final_state.is_terminal(), "complete() 只接受终态");
        self.busy_concurrency.remove(&req.concurrency_key);
        self.idempotency.insert(req.idempotency_key.clone(), final_state);
        let reason = if final_state == ActionState::Rejected
            || final_state == ActionState::Failed
            || final_state == ActionState::Expired
        {
            Some(format!("{:?}", final_state))
        } else {
            None
        };
        self.record(req, final_state, reason, false, now_ms);
    }

    fn reject(&mut self, req: &ActionRequest, reason: &str, now_ms: u64) -> Admission {
        self.record(req, ActionState::Rejected, Some(reason.to_string()), false, now_ms);
        Admission::Rejected { reason: reason.to_string() }
    }

    fn record(
        &mut self,
        req: &ActionRequest,
        final_state: ActionState,
        reason: Option<String>,
        deduplicated: bool,
        at_ms: u64,
    ) {
        self.journal.push(JournalEntry {
            command_id: req.command_id.clone(),
            idempotency_key: req.idempotency_key.clone(),
            capability_id: req.capability_id.clone(),
            final_state,
            reason,
            lease_epoch: req.lease_epoch,
            deduplicated,
            at_ms,
        });
        if self.journal.len() > 10_000 {
            self.journal.remove(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(idem: &str) -> ActionRequest {
        ActionRequest {
            command_id: format!("cmd_{idem}"),
            idempotency_key: idem.into(),
            capability_id: "robot.navigation.navigate_relative".into(),
            safety_class: SafetyClass::S2Guarded,
            concurrency_key: "base_motion".into(),
            deadline_ms: Some(60_000),
            lease_epoch: Some(5),
            expected_state_version: Some(1),
        }
    }

    #[test]
    fn idempotency_dedup_no_second_execution() {
        let mut g = EdgeGuard::new();
        let r = req("k1");
        assert_eq!(g.admit(&r, 0), Admission::Accepted);
        g.complete(&r, ActionState::Succeeded, 10);
        // 相同 idempotency_key 重试 → 重放，不再 Accept
        let r2 = ActionRequest { command_id: "cmd_other".into(), ..req("k1") };
        assert_eq!(
            g.admit(&r2, 20),
            Admission::Deduplicated { cached: ActionState::Succeeded }
        );
    }

    #[test]
    fn deadline_past_is_rejected() {
        let mut g = EdgeGuard::new();
        let r = ActionRequest { deadline_ms: Some(100), ..req("k") };
        match g.admit(&r, 200) {
            Admission::Rejected { reason } => assert!(reason.contains("deadline")),
            other => panic!("expected rejected, got {other:?}"),
        }
    }

    #[test]
    fn stale_lease_epoch_rejected() {
        let mut g = EdgeGuard::new();
        g.admit(&ActionRequest { lease_epoch: Some(10), ..req("a") }, 0);
        match g.admit(&ActionRequest { lease_epoch: Some(8), ..req("b") }, 0) {
            Admission::Rejected { reason } => assert!(reason.contains("stale lease")),
            other => panic!("expected rejected, got {other:?}"),
        }
        assert_eq!(g.device_lease_epoch(), 10);
    }

    #[test]
    fn concurrency_key_mutex_and_release() {
        let mut g = EdgeGuard::new();
        let a = req("a");
        assert_eq!(g.admit(&a, 0), Admission::Accepted); // 占用 base_motion
        // 同 key 第二个 → 拒绝
        match g.admit(&req("b"), 0) {
            Admission::Rejected { reason } => assert!(reason.contains("busy")),
            other => panic!("expected busy reject, got {other:?}"),
        }
        // 不同 key → 通过
        let arm = ActionRequest { concurrency_key: "arm".into(), ..req("c") };
        assert_eq!(g.admit(&arm, 0), Admission::Accepted);
        // 释放后同 key 可再次通过
        g.complete(&a, ActionState::Cancelled, 5);
        assert_eq!(g.admit(&req("d"), 0), Admission::Accepted);
    }

    #[test]
    fn s4_forbidden_rejected() {
        let mut g = EdgeGuard::new();
        let r = ActionRequest { safety_class: SafetyClass::S4Forbidden, ..req("x") };
        assert!(matches!(g.admit(&r, 0), Admission::Rejected { .. }));
    }

    #[test]
    fn journal_records_every_decision() {
        let mut g = EdgeGuard::new();
        let a = req("j1");
        g.admit(&a, 0);
        g.complete(&a, ActionState::Succeeded, 1);
        g.admit(&ActionRequest { command_id: "c2".into(), ..req("j1") }, 2); // dedup
        assert_eq!(g.journal().len(), 2);
        assert!(g.journal().iter().any(|e| e.deduplicated));
    }
}
