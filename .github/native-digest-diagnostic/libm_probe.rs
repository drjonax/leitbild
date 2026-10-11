// Temporary diagnostic: evaluate the libm functions the shared thermal laws
// call (`exp`, `ln`, `powf` at the laws' exponents, `powi(3)`), plus `sqrt` as
// a correctly rounded control, on a fixed deterministic input set. Writes the
// exact result bits so two platforms can be compared input by input.
// Usage: libm_probe <output file>
use std::io::Write;

fn main() {
    let out = std::env::args().nth(1).expect("output path");
    let mut file = std::fs::File::create(out).expect("create output");
    // Fixed linear congruential sequence: identical inputs on every platform.
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = || {
        state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (state >> 11) as f64 / (1_u64 << 53) as f64
    };
    let n = 20_000;
    let exponents = [0.5, 4., 3., 2., 1. / 3., 0.25, 2. / 3., 0.8, 0.668, 0.6774, 0.27, 0.15, 0.11];
    let mut columns: Vec<(&str, Vec<u64>)> = Vec::new();
    let mut exp = Vec::new();
    let mut ln = Vec::new();
    let mut sqrt = Vec::new();
    let mut powi3 = Vec::new();
    let mut pow: Vec<Vec<u64>> = vec![Vec::new(); exponents.len()];
    for _ in 0..n {
        let u = next();
        let x_exp = -60. + 120. * u;
        // Positive arguments spanning the laws' magnitudes (2^-27 .. 2^27),
        // built from bits so the inputs themselves use no libm call.
        let r = next().to_bits();
        let x_pos = f64::from_bits(((1023 - 27 + (r % 54)) << 52) | (r >> 12));
        exp.push(x_exp.exp().to_bits());
        ln.push(x_pos.ln().to_bits());
        sqrt.push(x_pos.sqrt().to_bits());
        powi3.push(x_pos.powi(3).to_bits());
        for (k, e) in exponents.iter().enumerate() {
            pow[k].push(x_pos.powf(*e).to_bits());
        }
    }
    columns.push(("exp", exp));
    columns.push(("ln", ln));
    columns.push(("sqrt", sqrt));
    columns.push(("powi3", powi3));
    let names: Vec<String> = exponents.iter().map(|e| format!("powf{e}")).collect();
    for (k, column) in pow.into_iter().enumerate() {
        columns.push((Box::leak(names[k].clone().into_boxed_str()), column));
    }
    for (name, column) in columns {
        writeln!(file, "{name} {}", column.iter().map(|b| format!("{b:016x}")).collect::<Vec<_>>().join(" ")).unwrap();
    }
}
