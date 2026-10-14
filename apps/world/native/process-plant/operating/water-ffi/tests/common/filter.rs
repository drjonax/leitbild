//! The accuracy contract's comparison machinery shared by the S1 and S2
//! gate harnesses (moved unchanged from s1_hydraulics.rs): summary
//! statistics, the declared zero-phase 4th-order Butterworth low-pass,
//! content above the credited band, H2's per-output cap-cycle judgement
//! and its Welch excess-spectrum diagnostic.
//!
//! Include it with `#[path = "common/filter.rs"] mod filter;`.
#![allow(dead_code)] // Each test crate uses its own subset.
use serde_json::{Value, json};
use std::f64::consts::PI;

/// The filter the harnesses implement; a declared block must name it.
pub const DECLARED_FILTER: &str = "zero-phase 4th-order Butterworth";

pub fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len() as f64
}
/// Population standard deviation.
pub fn deviation(v: &[f64]) -> f64 {
    let m = mean(v);
    (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}
pub fn rms(v: &[f64]) -> f64 {
    (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt()
}
/// The larger value; a NaN propagates rather than vanishing in a max.
pub fn larger(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
pub fn max_abs(v: &[f64]) -> f64 {
    v.iter().fold(0., |m, x| larger(m, x.abs()))
}
/// Fourth-order Butterworth low-pass at `cutoff_hz` for samples every `dt`
/// s: two bilinear biquads prewarped at the cutoff, each [b0, b1, b2, a1, a2].
pub fn butterworth(cutoff_hz: f64, dt: f64) -> [[f64; 5]; 2] {
    let (s, c) = (2. * PI * cutoff_hz * dt).sin_cos();
    [
        1. / (2. * (PI / 8.).cos()),
        1. / (2. * (3. * PI / 8.).cos()),
    ]
    .map(|q| {
        let alpha = s / (2. * q);
        let a0 = 1. + alpha;
        [
            (1. - c) / 2. / a0,
            (1. - c) / a0,
            (1. - c) / 2. / a0,
            -2. * c / a0,
            (1. - alpha) / a0,
        ]
    })
}
/// The cascade in transposed direct form II, each section started in its
/// steady state for its first input (unit DC gain).
pub fn cascade(x: &mut [f64], sections: &[[f64; 5]; 2]) {
    for &[b0, b1, b2, a1, a2] in sections {
        let first = x[0];
        let mut z2 = (b2 - a2) * first;
        let mut z1 = (b1 - a1) * first + z2;
        for v in x.iter_mut() {
            let input = *v;
            let out = b0 * input + z1;
            z1 = b1 * input - a1 * out + z2;
            z2 = b2 * input - a2 * out;
            *v = out;
        }
    }
}
/// Odd-reflection padding at each end, 5/cutoff s: about 12 e-folds of the
/// slowest pole, whose decay rate is 2 pi f_c sin(pi/8).
pub fn padding_s(cutoff_hz: f64) -> f64 {
    5. / cutoff_hz
}
/// The declared zero-phase 4th-order Butterworth low-pass of samples every
/// `dt` s: the cascade forward, then backward (|H|^2, -6 dB at the cutoff),
/// over odd reflection padding at both ends.
pub fn zero_phase_lowpass(x: &[f64], cutoff_hz: f64, dt: f64) -> Vec<f64> {
    let n = x.len();
    assert!(n >= 2, "a filtered series needs two observations");
    let pad = ((padding_s(cutoff_hz) / dt).round() as usize).min(n - 1);
    let sections = butterworth(cutoff_hz, dt);
    let mut ext: Vec<f64> = (1..=pad).rev().map(|i| 2. * x[0] - x[i]).collect();
    ext.extend_from_slice(x);
    ext.extend((1..=pad).map(|i| 2. * x[n - 1] - x[n - 1 - i]));
    cascade(&mut ext, &sections);
    ext.reverse();
    cascade(&mut ext, &sections);
    ext.reverse();
    ext[pad..pad + n].to_vec()
}
/// The Welch segment of the excess spectrum, about 2 s (H2's diagnostic).
pub const WELCH_SEGMENT_S: f64 = 2.;
pub const EXCESS_SPECTRUM_METHOD: &str = "diagnostic only, never a gate: one-sided Welch power spectral densities (unit^2/Hz) of the run's and R1's above-band content x - lowpass(x), the series the check uses; Hann windows of 2 s (the whole window when shorter), 50% overlap, each segment's mean removed, by direct DFT. Over the bins strictly above the cutoff: excess_hz is the bin with the largest P_run - P_R1 (null when no bin exceeds R1) and excess_density that difference, excess_share that bin's share of the run's power above the cutoff, and run_dominant_hz the run's own largest bin";
/// One-sided Welch power spectral density of `x`, sampled every `dt` s:
/// periodic-Hann segments of `segment_s` (the whole series when shorter) at
/// 50% overlap, each segment's mean removed, by direct DFT on exact
/// twiddles. Returns the density per bin k at k / (n dt) Hz (the unit
/// squared per Hz; its sum times the bin spacing is the series' variance),
/// the bin spacing and the number of segments.
pub fn welch(x: &[f64], dt: f64, segment_s: f64) -> (Vec<f64>, f64, usize) {
    let n = ((segment_s / dt).round() as usize).min(x.len());
    assert!(n >= 2, "a Welch segment needs two observations");
    let window: Vec<f64> = (0..n)
        .map(|i| 0.5 - 0.5 * (2. * PI * i as f64 / n as f64).cos())
        .collect();
    let (sin, cos): (Vec<f64>, Vec<f64>) = (0..n)
        .map(|j| (2. * PI * j as f64 / n as f64).sin_cos())
        .unzip();
    let mut density = vec![0.; n / 2 + 1];
    let mut segments = 0;
    for start in (0..=x.len() - n).step_by((n / 2).max(1)) {
        let segment = &x[start..start + n];
        let m = mean(segment);
        let tapered: Vec<f64> = segment
            .iter()
            .zip(&window)
            .map(|(v, w)| (v - m) * w)
            .collect();
        for (k, d) in density.iter_mut().enumerate() {
            let (mut re, mut im, mut j) = (0., 0., 0);
            for v in &tapered {
                re += v * cos[j];
                im -= v * sin[j];
                j += k;
                if j >= n {
                    j -= n;
                }
            }
            *d += re * re + im * im;
        }
        segments += 1;
    }
    let scale = dt / (window.iter().map(|w| w * w).sum::<f64>() * segments as f64);
    for (k, d) in density.iter_mut().enumerate() {
        // One-sided: every bin but DC and an even segment's Nyquist bin
        // carries its negative-frequency twin.
        *d *= if k == 0 || 2 * k == n {
            scale
        } else {
            2. * scale
        };
    }
    (density, 1. / (n as f64 * dt), segments)
}
/// H2's diagnostic on one output, never a gate: over the Welch bins strictly
/// above `cutoff_hz` of the run's and R1's above-band content, the bin of
/// the largest excess P_run - P_R1 (its frequency only where it is an
/// excess), that bin's share of the run's power above the cutoff, and the
/// run's own dominant frequency.
pub fn excess_spectrum(run: &[f64], r1: &[f64], dt: f64, cutoff_hz: f64) -> Value {
    let (p, df, segments) = welch(run, dt, WELCH_SEGMENT_S);
    let (q, _, _) = welch(r1, dt, WELCH_SEGMENT_S);
    let above: Vec<usize> = (0..p.len())
        .filter(|k| *k as f64 * df > cutoff_hz)
        .collect();
    let power: f64 = above.iter().map(|k| p[*k]).sum();
    let largest =
        |f: &dyn Fn(usize) -> f64| above.iter().copied().max_by(|a, b| f(*a).total_cmp(&f(*b)));
    let excess = largest(&|k| p[k] - q[k]).filter(|k| p[*k] > q[*k]);
    let dominant = largest(&|k| p[k]).filter(|_| power > 0.);
    json!({"excess_hz":excess.map(|k| k as f64 * df),"excess_density":excess.map(|k| p[k] - q[k]),"excess_share":excess.map(|k| p[k] / power),
        "run_dominant_hz":dominant.map(|k| k as f64 * df),"run_power_above_cutoff":power * df,
        "resolution_hz":df,"segment_s":1. / df,"segments":segments})
}

/// A series' own content above the credited band, x - lowpass(x), taken
/// relative to its first value: the filter is linear with unit DC gain, so
/// the content is unchanged and rounding stays small.
pub fn content_above_band(raw: &[f64], cutoff_hz: f64, dt: f64) -> Vec<f64> {
    let x: Vec<f64> = raw.iter().map(|v| v - raw[0]).collect();
    let low = zero_phase_lowpass(&x, cutoff_hz, dt);
    x.iter().zip(&low).map(|(a, b)| a - b).collect()
}
/// H2's rule for one output of the cap-cycle check, as receipts state it.
pub const CAP_CYCLE_RULE: &str = "an output passes if its run RMS above the cutoff is at or below its floor (H2: the declared fraction of its credited budget, the roof's being its sample-noise budget), or at most ratio_max times R1's; judged is true where the run RMS exceeds the floor";
/// E3's cap-cycle judgement of one output as amended by H2, on the run's and
/// R1's content above the credited band ([`content_above_band`]): the output
/// passes if its RMS is at or below `floor`, or at most `ratio_max` times
/// R1's; the ratio is judged only above the floor. The receipt entry carries
/// the excess spectrum ([`excess_spectrum`]), a diagnostic that judges
/// nothing.
pub fn cap_cycle_output(
    run: &[f64],
    r1: &[f64],
    floor: f64,
    ratio_max: f64,
    dt: f64,
    cutoff_hz: f64,
) -> (Value, bool) {
    let (x, y) = (rms(run), rms(r1));
    let below_floor = x <= floor;
    let pass = below_floor || x <= ratio_max * y;
    (
        json!({"run_rms":x,"r1_rms":y,"ratio":x / y,"floor":floor,"judged":!below_floor,"pass":pass,
            "excess_spectrum":excess_spectrum(run, r1, dt, cutoff_hz)}),
        pass,
    )
}
