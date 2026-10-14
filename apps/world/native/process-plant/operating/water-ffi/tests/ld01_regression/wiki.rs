//! Wiki provenance for receipts: the git tree hash of the wiki directory
//! read, and the commit it is verified to be. The same rules as
//! `apps/world/scripts/reference-design-wiki-provenance.ts`:
//!
//! - `LD01_WIKI_COMMIT` names a commit; it is accepted only when its tree,
//!   resolved in `LD01_WIKI_REPOSITORY` (or the root itself when it is a
//!   checkout), equals the directory's tree hash. Otherwise the receipt
//!   refuses: a `git archive` extraction carries no commit of its own.
//! - A checkout without `LD01_WIKI_COMMIT` is its HEAD, and the receipt
//!   says whether its files match HEAD's tree.
//! - Otherwise the commit is null and the tree hash identifies the content.
//!
//! The tree hash is git's own (`git write-tree` over the directory in a
//! throwaway repository, ignore rules and line-ending conversion off).
//! Include with `#[path = "ld01_regression/wiki.rs"] mod wiki;`.
#![allow(dead_code)] // Each test crate uses its own subset.
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;

fn git(args: &[&str], env: &[(&str, &Path)]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.args(args);
    for (k, v) in env {
        command.env(k, v);
    }
    let out = command.output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Git's tree id of `root` as a commit of its files would store it.
pub fn tree_hash(root: &Path) -> Result<String, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let scratch =
        std::env::temp_dir().join(format!("ld01-wiki-tree-{}-{nanos}", std::process::id()));
    let result = (|| {
        git(&["init", "-q", "--bare", &scratch.to_string_lossy()], &[])?;
        let index = scratch.join("index");
        let env = [
            ("GIT_DIR", scratch.as_path()),
            ("GIT_INDEX_FILE", index.as_path()),
            ("GIT_WORK_TREE", root),
        ];
        let flags = [
            "-c",
            "core.excludesFile=/dev/null",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.fileMode=true",
        ];
        let mut add = flags.to_vec();
        add.extend(["add", "-A", "-f", "."]);
        let mut command = Command::new("git");
        command.current_dir(root).args(&add);
        for (k, v) in &env {
            command.env(k, v);
        }
        let out = command.output().map_err(|e| format!("git add: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "git add: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        git(&["write-tree"], &env)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// The wiki provenance of `root` under `LD01_WIKI_COMMIT` and
/// `LD01_WIKI_REPOSITORY`; `Err` when a named commit cannot be verified.
pub fn provenance(root: &Path) -> Result<Value, String> {
    provenance_with(
        root,
        std::env::var("LD01_WIKI_COMMIT").ok().as_deref(),
        std::env::var("LD01_WIKI_REPOSITORY").ok().as_deref(),
    )
}
/// [`provenance`] with the commit and repository given.
pub fn provenance_with(
    root: &Path,
    named: Option<&str>,
    repository: Option<&str>,
) -> Result<Value, String> {
    let tree = tree_hash(root)?;
    let checkout = root.join(".git").exists();
    let root_s = root.to_string_lossy().to_string();
    if let Some(named) = named {
        let repository = repository
            .map(str::to_string)
            .or(checkout.then(|| root_s.clone()))
            .ok_or("LD01_WIKI_COMMIT needs LD01_WIKI_REPOSITORY (the wiki git repository) to verify it")?;
        let commit = git(
            &[
                "-C",
                &repository,
                "rev-parse",
                "--verify",
                &format!("{named}^{{commit}}"),
            ],
            &[],
        )?;
        let committed = git(
            &[
                "-C",
                &repository,
                "rev-parse",
                "--verify",
                &format!("{commit}^{{tree}}"),
            ],
            &[],
        )?;
        if committed != tree {
            return Err(format!(
                "LD01_WIKI_COMMIT {named} has tree {committed}, but {root_s} is tree {tree}"
            ));
        }
        return Ok(
            json!({"root": root_s, "tree": tree, "commit": commit, "basis": "LD01_WIKI_COMMIT verified against the tree"}),
        );
    }
    if checkout {
        let commit = git(
            &["-C", &root_s, "rev-parse", "--verify", "HEAD^{commit}"],
            &[],
        )?;
        let head = git(
            &[
                "-C",
                &root_s,
                "rev-parse",
                "--verify",
                &format!("{commit}^{{tree}}"),
            ],
            &[],
        )?;
        let basis = if head == tree {
            "checkout HEAD, files match its tree"
        } else {
            "checkout HEAD, files differ from its tree"
        };
        return Ok(json!({"root": root_s, "tree": tree, "commit": commit, "basis": basis}));
    }
    Ok(
        json!({"root": root_s, "tree": tree, "commit": null, "basis": "no commit named: the tree identifies the content"}),
    )
}
