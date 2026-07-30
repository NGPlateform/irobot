//! Edge 进程行协议（TAB 分隔，零依赖）。TS Orchestrator ↔ Rust edge-daemon。
//!
//! 请求（TS → Rust）：
//!   ADMIT \t cmd \t idem \t capability \t safety \t ckey \t deadline_ms|- \t lease|- \t now_ms
//!   COMPLETE \t cmd \t idem \t capability \t ckey \t final_state \t lease|- \t now_ms
//! 应答（Rust → TS）：
//!   ACCEPTED \t cmd
//!   DEDUP \t cmd \t <state>
//!   REJECT \t cmd \t <reason>
//!   OK \t cmd            (COMPLETE 确认)

use crate::action_state::ActionState;
use crate::edge_guard::{ActionRequest, Admission};
use crate::safety::SafetyClass;

pub enum Request {
    Admit { req: ActionRequest, now_ms: u64 },
    Complete { req: ActionRequest, final_state: ActionState, now_ms: u64 },
}

fn opt_u64(s: &str) -> Option<u64> {
    if s == "-" { None } else { s.parse().ok() }
}

/// 解析一行请求。字段不足/非法 → None（fail-closed，调用方拒绝）。
pub fn parse_request(line: &str) -> Option<Request> {
    let f: Vec<&str> = line.trim_end().split('\t').collect();
    match f.first().copied()? {
        "ADMIT" if f.len() == 9 => {
            let req = ActionRequest {
                command_id: f[1].to_string(),
                idempotency_key: f[2].to_string(),
                capability_id: f[3].to_string(),
                safety_class: SafetyClass::parse(f[4])?,
                concurrency_key: f[5].to_string(),
                deadline_ms: opt_u64(f[6]),
                lease_epoch: opt_u64(f[7]),
                expected_state_version: None,
            };
            Some(Request::Admit { req, now_ms: f[8].parse().ok()? })
        }
        "COMPLETE" if f.len() == 8 => {
            let req = ActionRequest {
                command_id: f[1].to_string(),
                idempotency_key: f[2].to_string(),
                capability_id: f[3].to_string(),
                safety_class: SafetyClass::S2Guarded, // complete 不用它
                concurrency_key: f[4].to_string(),
                deadline_ms: None,
                lease_epoch: opt_u64(f[6]),
                expected_state_version: None,
            };
            Some(Request::Complete {
                req,
                final_state: ActionState::parse_wire(f[5])?,
                now_ms: f[7].parse().ok()?,
            })
        }
        _ => None,
    }
}

pub fn format_admission(command_id: &str, adm: &Admission) -> String {
    match adm {
        Admission::Accepted => format!("ACCEPTED\t{command_id}"),
        Admission::Deduplicated { cached } => format!("DEDUP\t{command_id}\t{}", cached.wire()),
        Admission::Rejected { reason } => format!("REJECT\t{command_id}\t{reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_admit() {
        let line = "ADMIT\tcmd1\tk1\trobot.navigation.navigate_relative\tS2_GUARDED\tbase_motion\t60000\t5\t100";
        match parse_request(line) {
            Some(Request::Admit { req, now_ms }) => {
                assert_eq!(req.command_id, "cmd1");
                assert_eq!(req.safety_class, SafetyClass::S2Guarded);
                assert_eq!(req.concurrency_key, "base_motion");
                assert_eq!(req.deadline_ms, Some(60000));
                assert_eq!(req.lease_epoch, Some(5));
                assert_eq!(now_ms, 100);
            }
            _ => panic!("expected admit"),
        }
    }

    #[test]
    fn optional_fields_dash() {
        let line = "ADMIT\tc\tk\tcap\tS0_OBSERVE\ttelemetry\t-\t-\t0";
        match parse_request(line).unwrap() {
            Request::Admit { req, .. } => {
                assert_eq!(req.deadline_ms, None);
                assert_eq!(req.lease_epoch, None);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_complete() {
        let line = "COMPLETE\tcmd1\tk1\tcap\tbase_motion\tSUCCEEDED\t5\t200";
        match parse_request(line).unwrap() {
            Request::Complete { final_state, now_ms, .. } => {
                assert_eq!(final_state, ActionState::Succeeded);
                assert_eq!(now_ms, 200);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn malformed_is_none() {
        assert!(parse_request("ADMIT\ttoo\tfew").is_none());
        assert!(parse_request("BOGUS\tx").is_none());
        assert!(parse_request("ADMIT\tc\tk\tcap\tSXX\tck\t-\t-\t0").is_none()); // 非法 safety
    }

    #[test]
    fn format_replies() {
        assert_eq!(format_admission("c", &Admission::Accepted), "ACCEPTED\tc");
        assert_eq!(
            format_admission("c", &Admission::Deduplicated { cached: ActionState::Succeeded }),
            "DEDUP\tc\tSUCCEEDED"
        );
        assert_eq!(
            format_admission("c", &Admission::Rejected { reason: "busy".into() }),
            "REJECT\tc\tbusy"
        );
    }
}
