"""Instrument heater_shared_thermal_digest.rs to log every hashed value.

Temporary diagnostic for the Linux CI digest mismatch; not part of the fix.
It leaves the digest arithmetic untouched and only records, in hashing order,
each outcome marker, each Scalar's exact bits and each mode, so two platforms'
or two commits' logs can be compared case by case.
Usage: python3 -I instrument.py <path to heater_shared_thermal_digest.rs>
"""
import sys

path = sys.argv[1]
text = open(path).read()

edits = [
    (
        "use leitbild_operating_plant::thermal::*;\n",
        "use leitbild_operating_plant::thermal::*;\n"
        "static LOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());\n"
        "fn log(line: String) {\n"
        "    LOG.lock().unwrap().push(line);\n"
        "}\n",
    ),
    (
        "    fn scalar(&mut self, x: Scalar) {\n",
        "    fn scalar(&mut self, x: Scalar) {\n"
        '        log(format!("s {:016x} {:016x} {:e} {:e}", x.value.to_bits(), x.direction.to_bits(), x.value, x.direction));\n',
    ),
    (
        '                self.bytes(b"ok");\n',
        '                self.bytes(b"ok");\n'
        '                log("ok".to_string());\n',
    ),
    (
        '                self.bytes(b"err");\n',
        '                self.bytes(b"err");\n'
        '                log(format!("err {e}"));\n',
    ),
    (
        "    d.bytes(q.mode.as_bytes());\n",
        "    d.bytes(q.mode.as_bytes());\n"
        '    log(format!("mode {}", q.mode));\n',
    ),
    (
        "    let (digest, modes) = shared_digest();\n",
        "    let (digest, modes) = shared_digest();\n"
        '    if let Ok(out) = std::env::var("DIGEST_LOG") {\n'
        '        let mut lines = LOG.lock().unwrap().clone();\n'
        '        lines.push(format!("digest {digest:#018x} modes {modes:?}"));\n'
        '        std::fs::write(out, lines.join("\\n") + "\\n").unwrap();\n'
        "    }\n",
    ),
]

for old, new in edits:
    if text.count(old) != 1:
        sys.exit(f"instrument: expected exactly one occurrence of {old!r}")
    text = text.replace(old, new)

open(path, "w").write(text)
