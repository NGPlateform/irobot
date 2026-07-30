//! 安全等级与确定性前置条件（与 @irobot/policy-contract 一致）。
//! Edge Safety Supervisor 的判定层：这些检查在快环、不经 LLM/网络。

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyClass {
    S0Observe,
    S1Reversible,
    S2Guarded,
    S3Hazardous,
    S4Forbidden,
}

impl SafetyClass {
    /// 是否允许由 Agent 发起提案。S4 永远为 false（安全不变量 §4.1）。
    pub fn agent_may_propose(self) -> bool {
        !matches!(self, SafetyClass::S4Forbidden)
    }

    /// 是否要求 Edge 侧重新读取本地实时状态做二次判定（安全关键条件）。
    pub fn requires_edge_revalidation(self) -> bool {
        matches!(
            self,
            SafetyClass::S2Guarded | SafetyClass::S3Hazardous | SafetyClass::S4Forbidden
        )
    }

    pub fn parse(s: &str) -> Option<SafetyClass> {
        Some(match s {
            "S0_OBSERVE" => SafetyClass::S0Observe,
            "S1_REVERSIBLE" => SafetyClass::S1Reversible,
            "S2_GUARDED" => SafetyClass::S2Guarded,
            "S3_HAZARDOUS" => SafetyClass::S3Hazardous,
            "S4_FORBIDDEN" => SafetyClass::S4Forbidden,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Ge,
    Le,
    Gt,
    Lt,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Num(f64),
    Bool(bool),
}

/// 前置条件三元式（path op value），由确定性解释器计算，非 LLM。
#[derive(Debug, Clone)]
pub struct Precondition {
    pub path: String,
    pub op: Op,
    pub value: Value,
}

/// 设备状态快照（safety.estop / localization.healthy / battery.percent 等）。
pub type StateSnapshot = HashMap<String, Value>;

/// 评估单条前置条件。未知路径视为不满足（fail-closed，安全不变量 §4.1#4）。
pub fn eval_precondition(p: &Precondition, snap: &StateSnapshot) -> bool {
    let Some(actual) = snap.get(&p.path) else {
        return false;
    };
    match (actual, &p.value, p.op) {
        (Value::Bool(a), Value::Bool(b), Op::Eq) => a == b,
        (Value::Bool(a), Value::Bool(b), Op::Ne) => a != b,
        (Value::Num(a), Value::Num(b), Op::Eq) => a == b,
        (Value::Num(a), Value::Num(b), Op::Ne) => a != b,
        (Value::Num(a), Value::Num(b), Op::Ge) => a >= b,
        (Value::Num(a), Value::Num(b), Op::Le) => a <= b,
        (Value::Num(a), Value::Num(b), Op::Gt) => a > b,
        (Value::Num(a), Value::Num(b), Op::Lt) => a < b,
        _ => false, // 类型不匹配 → fail-closed
    }
}

/// 全部前置条件满足才通过；返回首个未满足项（供拒绝原因）。
pub fn check_preconditions<'a>(
    preconds: &'a [Precondition],
    snap: &StateSnapshot,
) -> Option<&'a Precondition> {
    preconds.iter().find(|p| !eval_precondition(p, snap))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> StateSnapshot {
        let mut s = StateSnapshot::new();
        s.insert("safety.estop".into(), Value::Bool(false));
        s.insert("localization.healthy".into(), Value::Bool(true));
        s.insert("battery.percent".into(), Value::Num(82.0));
        s
    }

    #[test]
    fn s4_never_proposable() {
        assert!(!SafetyClass::S4Forbidden.agent_may_propose());
        assert!(SafetyClass::S2Guarded.agent_may_propose());
    }

    #[test]
    fn s2_s3_require_edge_revalidation() {
        assert!(SafetyClass::S2Guarded.requires_edge_revalidation());
        assert!(SafetyClass::S3Hazardous.requires_edge_revalidation());
        assert!(!SafetyClass::S0Observe.requires_edge_revalidation());
    }

    #[test]
    fn preconditions_pass_and_fail() {
        let ok = vec![
            Precondition { path: "safety.estop".into(), op: Op::Eq, value: Value::Bool(false) },
            Precondition { path: "battery.percent".into(), op: Op::Ge, value: Value::Num(10.0) },
        ];
        assert!(check_preconditions(&ok, &snap()).is_none());

        let mut estopped = snap();
        estopped.insert("safety.estop".into(), Value::Bool(true));
        let failing = check_preconditions(&ok, &estopped).unwrap();
        assert_eq!(failing.path, "safety.estop");
    }

    #[test]
    fn unknown_path_fails_closed() {
        let p = vec![Precondition { path: "nope".into(), op: Op::Eq, value: Value::Bool(true) }];
        assert!(check_preconditions(&p, &snap()).is_some());
    }
}
