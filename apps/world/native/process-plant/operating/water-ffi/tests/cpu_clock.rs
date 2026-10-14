//! The harnesses' portable CPU clocks (`tests/common/cpu.rs`) on this
//! target: the declared clock ids, monotone readings that advance with work,
//! process CPU covering thread CPU, the scheduling request and the load
//! average. Runs on macOS and Linux without packets or SUNDIALS.
#[path = "common/cpu.rs"]
mod cpu;

/// Spins until this thread has used at least `seconds` of CPU.
fn busy(seconds: f64) -> f64 {
    let started = cpu::thread_cpu_s();
    let mut x = 1.0_f64;
    while cpu::thread_cpu_s() - started < seconds {
        for _ in 0..10_000 {
            x = (x * 1.000_000_1).sqrt() + 1e-9;
        }
    }
    std::hint::black_box(x)
}

#[test]
fn clock_ids_are_the_targets_own() {
    if cfg!(target_os = "macos") {
        assert_eq!((cpu::PROCESS_CPU_CLOCK, cpu::THREAD_CPU_CLOCK), (12, 16));
    } else {
        assert_eq!((cpu::PROCESS_CPU_CLOCK, cpu::THREAD_CPU_CLOCK), (2, 3));
    }
}

#[test]
fn thread_and_process_clocks_advance_with_work() {
    cpu::prefer_performance_core();
    let (thread0, process0) = (cpu::thread_cpu_s(), cpu::process_cpu_s());
    busy(0.05);
    let (thread1, process1) = (cpu::thread_cpu_s(), cpu::process_cpu_s());
    assert!(
        thread1 - thread0 >= 0.05,
        "thread CPU {thread0} -> {thread1}"
    );
    // The process clock sums every thread's CPU, this one's included.
    assert!(
        process1 - process0 >= 0.9 * (thread1 - thread0),
        "process CPU {process0} -> {process1} against thread {thread0} -> {thread1}"
    );
    assert!(process1 >= thread1);
}

#[test]
fn a_sleeping_thread_uses_no_thread_cpu() {
    let started = cpu::thread_cpu_s();
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(cpu::thread_cpu_s() - started < 0.02);
}

#[test]
fn load_average_reads_three_numbers() {
    let values = cpu::load_averages();
    assert_eq!(values.len(), 3, "{:?}", cpu::load_average());
    assert!(values.iter().all(|v| v.is_finite() && *v >= 0.));
    assert!(!cpu::SCHEDULING.is_empty());
}
