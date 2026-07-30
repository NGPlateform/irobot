//! iRobot Edge daemon：长驻进程，通过 stdin/stdout 行协议提供 EdgeGuard 准入。
//! 由上位机（TS Orchestrator）在执行写动作前调用；这是架构里的 Edge 权威安全层。
//!
//! 用法：`edge-daemon`，逐行读 ADMIT/COMPLETE，逐行回 ACCEPTED/DEDUP/REJECT/OK。
//! 每行处理完立即 flush，保证请求-应答同步。

use irobot_edge_runtime::edge_guard::EdgeGuard;
use irobot_edge_runtime::protocol::{format_admission, parse_request, Request};
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    let mut guard = EdgeGuard::new();
    eprintln!("[edge-daemon] ready");

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match parse_request(&line) {
            Some(Request::Admit { req, now_ms }) => {
                let adm = guard.admit(&req, now_ms);
                format_admission(&req.command_id, &adm)
            }
            Some(Request::Complete { req, final_state, now_ms }) => {
                guard.complete(&req, final_state, now_ms);
                format!("OK\t{}", req.command_id)
            }
            Some(Request::SetState { estop, loc_healthy, battery }) => {
                guard.set_state(estop, loc_healthy, battery);
                "OK\t-".to_string()
            }
            None => "REJECT\t-\tmalformed request".to_string(),
        };
        if writeln!(out, "{reply}").is_err() || out.flush().is_err() {
            break;
        }
    }
}
