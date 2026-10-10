use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=LD01_OPERATING_WATER_LIB_DIR");
    let directory =
        PathBuf::from(env::var_os("LD01_OPERATING_WATER_LIB_DIR").expect(
            "Build the pinned IF97 boundary with reference-design-operating-water.ts first",
        ));
    assert!(
        directory.is_absolute(),
        "Water artifact directory must be absolute"
    );
    let library = directory.join("libld01_operating_water.a");
    let receipt = directory.join("water-build.json");
    assert!(
        library.is_file() && receipt.is_file(),
        "Missing water archive/build receipt"
    );
    println!("cargo:rerun-if-changed={}", library.display());
    println!("cargo:rerun-if-changed={}", receipt.display());
    println!("cargo:rustc-link-search=native={}", directory.display());
    println!("cargo:rustc-link-lib=static=ld01_operating_water");
    let target = env::var("CARGO_CFG_TARGET_OS").expect("target OS");
    println!(
        "cargo:rustc-link-lib={}",
        if target == "macos" { "c++" } else { "stdc++" }
    );
    println!("cargo:rerun-if-env-changed=LD01_OPERATING_SUNDIALS_PREFIX");
    if env::var_os("CARGO_FEATURE_IDA").is_some() {
        let prefix = PathBuf::from(
            env::var_os("LD01_OPERATING_SUNDIALS_PREFIX")
                .expect("ida feature requires an explicitly verified stock SUNDIALS prefix"),
        );
        assert!(prefix.is_absolute() && prefix.join("include/ida/ida.h").is_file());
        // These headers define the ABI of this glue. A verified prefix can be
        // rebuilt in place; an unchanged path must not leave stale C objects.
        // Cargo scans directory dependencies recursively, including transitive
        // headers, without a second manually maintained header inventory.
        println!(
            "cargo:rerun-if-changed={}",
            prefix.join("include").display()
        );
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        let object = out.join("operating_ida.o");
        assert!(
            Command::new("cc")
                .args([
                    "-std=c11",
                    "-O3",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    "-c",
                    "src/ida.c",
                    "-o"
                ])
                .arg(&object)
                .arg("-I")
                .arg(prefix.join("include"))
                .arg("-I")
                .arg(prefix.join("include/suitesparse"))
                .status()
                .expect("compile stock IDA boundary")
                .success()
        );
        assert!(
            Command::new("ar")
                .arg("crs")
                .arg(out.join("liboperating_ida.a"))
                .arg(&object)
                .status()
                .expect("archive IDA boundary")
                .success()
        );
        println!("cargo:rerun-if-changed=src/ida.c");
        println!("cargo:rustc-link-search=native={}", out.display());
        println!(
            "cargo:rustc-link-search=native={}",
            prefix.join("lib").display()
        );
        println!(
            "cargo:rustc-link-arg=-Wl,-rpath,{}",
            prefix.join("lib").display()
        );
        println!("cargo:rustc-link-lib=static=operating_ida");
        for name in [
            "ida",
            "nvecserial",
            "sunmatrixsparse",
            "sunlinsolklu",
            "core",
        ] {
            println!("cargo:rustc-link-lib=sundials_{name}");
        }
    }
}
