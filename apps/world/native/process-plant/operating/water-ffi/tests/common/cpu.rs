//! Portable CPU clocks, scheduling hint and load average for the measurement
//! harnesses (S1, P2, Jacobian, S2). Measurement support only; nothing here
//! is a production path and nothing changes a computation.
//!
//! Include it from a test crate with `#[path = "common/cpu.rs"] mod cpu;`
//! (from a harness directory's `mod.rs`: `#[path = "../common/cpu.rs"]`).
//!
//! | Clock / call | macOS | Linux |
//! | --- | --- | --- |
//! | `CLOCK_PROCESS_CPUTIME_ID` | 12 | 2 |
//! | `CLOCK_THREAD_CPUTIME_ID` | 16 | 3 |
//! | performance-core request | `pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE)` | none: no QoS classes; affinity is left to the scheduler |
//! | load average | `sysctl -n vm.loadavg` | `/proc/loadavg` |
//!
//! `struct timespec` is `{ i64, i64 }` and `clockid_t` an `int` on both
//! targets (64-bit). Any other target refuses to compile rather than guess.
#![allow(dead_code)] // Each test crate uses its own subset.

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("tests/common/cpu.rs knows the clock ids of macOS and Linux only");

/// `CLOCK_PROCESS_CPUTIME_ID` of this target.
pub const PROCESS_CPU_CLOCK: i32 = if cfg!(target_os = "macos") { 12 } else { 2 };
/// `CLOCK_THREAD_CPUTIME_ID` of this target.
pub const THREAD_CPU_CLOCK: i32 = if cfg!(target_os = "macos") { 16 } else { 3 };

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn pthread_set_qos_class_self_np(class: u32, priority: i32) -> i32;
}

fn clock(id: i32) -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(id, &mut t) };
    assert_eq!(status, 0, "CPU clock {id} unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}

/// Process CPU seconds (all threads), as the S1 and P2 harnesses measure.
pub fn process_cpu_s() -> f64 {
    clock(PROCESS_CPU_CLOCK)
}

/// This thread's CPU seconds.
pub fn thread_cpu_s() -> f64 {
    clock(THREAD_CPU_CLOCK)
}

/// macOS: QOS_CLASS_USER_INTERACTIVE asks the scheduler for a performance
/// core, so efficiency-core placement on the shared machine does not enter a
/// comparison. Linux has no QoS classes and no portable core-kind request;
/// nothing is called there (see [`SCHEDULING`]).
pub fn prefer_performance_core() {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: plain scalar arguments; affects only this thread's
        // scheduling.
        let status = unsafe { pthread_set_qos_class_self_np(0x21, 0) };
        assert_eq!(status, 0, "thread QoS unavailable");
    }
}

/// What [`prefer_performance_core`] did on this target, for receipts.
pub const SCHEDULING: &str = if cfg!(target_os = "macos") {
    "QOS_CLASS_USER_INTERACTIVE"
} else {
    "scheduler default (Linux: no QoS class; no affinity set)"
};

/// The 1-, 5- and 15-minute load averages as the platform prints them
/// (macOS `{ 4.12 4.33 4.40 }`; Linux `0.10 0.20 0.30 1/234 5678`).
pub fn load_average() -> String {
    if cfg!(target_os = "macos") {
        std::process::Command::new("sysctl")
            .args(["-n", "vm.loadavg"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .expect("load average")
    } else {
        std::fs::read_to_string("/proc/loadavg")
            .expect("load average")
            .trim()
            .to_string()
    }
}

/// The three load averages as numbers.
pub fn load_averages() -> Vec<f64> {
    load_average()
        .split_whitespace()
        .filter_map(|w| w.parse().ok())
        .take(3)
        .collect()
}
