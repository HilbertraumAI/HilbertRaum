// HilbertRaum native launcher — prepares the runtime, then runs the bundled Electron app.
//
// HilbertRaum is a self-contained Electron app: its main process runs llama.cpp, RAG,
// embeddings, SQLite, OCR and document ingestion internally, and manages its own model
// weights + sidecar binaries from the drive. So this launcher only has to make the shipped
// app component available and supervise the app — there is NO daemon, NO supervisor, NO
// localhost service stack, and nothing from mac-mgmt.
//
//   linux : MOUNT the app .squashfs via the loader's embedded squashfuse (extract if FUSE
//           is unavailable); macОS: attach the .dmg; windows: the component ships extracted.
// It exports the loader resource env + HILBERTRAUM_DRIVE_ROOT, launches Electron, waits, and
// tears the mount down on exit. All of that sequencing lives in the shared loader lifecycle
// (third_party/loader); the project-specific bodies live in `project`.
use std::path::{Path, PathBuf};

use clap::Parser;

mod project;
mod serve;

// The FHS-entry / component-mount / pool-discovery / splash / cache+lock substrate, the
// shared HTTP client, and the crash-safe self-updater live in the loader-core runtime crate.
pub(crate) use loader_core::{external_roots, log};

/// Find the Electron executable inside a provided app component tree (the dir the
/// `app-<os>` component was mounted/linked/extracted to). electron-builder names the
/// binary after `productName` ("HilbertRaum"); linux lowercases it.
///   macOS  : <app>/HilbertRaum.app/Contents/MacOS/HilbertRaum
///   windows: <app>/HilbertRaum.exe
///   linux  : <app>/hilbertraum
fn electron_in(app: &Path) -> Option<PathBuf> {
    let mac = app.join("HilbertRaum.app/Contents/MacOS/HilbertRaum");
    if mac.exists() {
        return Some(mac);
    }
    for name in ["HilbertRaum.exe", "hilbertraum", "HilbertRaum", "hilbertraum.exe"] {
        let p = app.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Fallback: locate a HilbertRaum Electron executable beside the launcher (back-compat
/// with an app shipped next to the launcher rather than as an `app-<os>` component).
fn electron_target(here: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HILBERTRAUM_ELECTRON").map(PathBuf::from) {
        if p.exists() {
            return Some(p);
        }
    }
    let me = std::env::current_exe().ok();
    for root in external_roots(here) {
        let mac = root.join("HilbertRaum.app/Contents/MacOS/HilbertRaum");
        if mac.exists() && me.as_ref().map(|e| *e != mac).unwrap_or(true) {
            return Some(mac);
        }
        for name in ["HilbertRaum.exe", "hilbertraum", "HilbertRaum"] {
            let p = root.join(name);
            if p.exists() && me.as_ref().map(|e| *e != p).unwrap_or(true) {
                return Some(p);
            }
        }
    }
    None
}

/// The launcher CLI. The default (no subcommand) runs the app: the dev-override flags feed
/// env overrides, and any trailing args are forwarded to Electron. `self-update` is the one
/// ops helper (it runs and exits).
#[derive(clap::Parser)]
#[command(name = "hilbertraum", about = "HilbertRaum launcher", args_conflicts_with_subcommands = true)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
    #[command(flatten)]
    run: RunArgs,
}

#[derive(clap::Args)]
struct RunArgs {
    /// Dev: replace the pooled `app` component with a local folder, e.g.
    /// `--with app=./app/apps/desktop/release/linux-unpacked`.
    #[arg(long = "with", value_name = "SLOT=DIR")]
    with: Vec<String>,
    /// Dev: run a locally-built unpacked Electron app tree instead of the app component.
    #[arg(long, value_name = "DIR")]
    start_with_electron: Option<PathBuf>,
    /// Extra args forwarded to Electron (use `--` first for leading flags).
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    electron_args: Vec<std::ffi::OsString>,
}

#[derive(clap::Subcommand)]
enum Cmd {
    /// Ops: check the update server, download the delta, and apply it (no Electron).
    SelfUpdate,
}

/// Apply the app-mode dev overrides to the process env (before the env snapshot, so a
/// post-update relaunch — which restores env0 — keeps them).
fn apply_dev_overrides(run: &RunArgs) {
    let canon = |d: &Path| d.canonicalize().unwrap_or_else(|_| d.to_path_buf());
    // The generic `--with <slot>=<dir>` component override lives in loader-core (it
    // pairs with the mount-time `provide_or_override`).
    if let Err(e) = loader_core::apply_slot_overrides(&run.with) {
        log(&e);
        std::process::exit(2);
    }
    if let Some(d) = &run.start_with_electron {
        std::env::set_var("HILBERTRAUM_APP_DIR", canon(d));
    }
}

fn main() {
    // Pin the cache dir name before anything touches cache_root() — incl. the CLI
    // subcommand below, which runs before the lifecycle would set it from the Project.
    loader_core::set_cache_dir_name(project::CACHE_DIR_NAME);

    let cli = Cli::parse();
    if let Some(Cmd::SelfUpdate) = cli.cmd {
        std::process::exit(loader_core::update::self_update("HilbertRaum"));
    }

    // App mode: apply dev overrides to the env BEFORE snapshotting it.
    apply_dev_overrides(&cli.run);

    // Snapshot the Electron args + the environment BEFORE the run mutates anything: a
    // relaunch after an update apply must start from this state, not from the run's
    // (PLANAI_RESOURCES etc. would point a fresh launcher at torn-down mounts).
    let args = cli.run.electron_args;
    let env0: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os().collect();

    let exe = std::env::current_exe().expect("current_exe");
    let here = exe.parent().expect("exe parent").to_path_buf();

    // Single-instance guard — held until exit (or handed over on relaunch); a second
    // launch is notified + exits inside loader-core. Brand fills the localized text.
    let instance_lock = loader_core::acquire_run_lock("HilbertRaum");

    // Everything else — provisioning, mounting, the session, teardown, update apply,
    // relaunch — is the shared lifecycle state machine (loader-core), driven by the
    // HilbertRaum project bodies (mount the app + run Electron + splash text).
    loader_core::lifecycle::run(
        loader_core::lifecycle::Ctx::new(exe, here, args, env0, instance_lock),
        Box::new(project::HilbertRaum::new()),
    );
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("hilbertraum").chain(args.iter().copied())).unwrap()
    }

    #[test]
    fn cli_covers_app_mode_dev_flags_and_self_update() {
        // bare invocation → app mode, no subcommand, no electron args
        let c = parse(&[]);
        assert!(c.cmd.is_none() && c.run.electron_args.is_empty() && c.run.with.is_empty());

        // dev overrides (app mode)
        let c = parse(&["--with", "app=./app", "--start-with-electron", "./unpacked"]);
        assert!(c.cmd.is_none());
        assert_eq!(c.run.with, vec!["app=./app"]);
        assert_eq!(c.run.start_with_electron.as_deref(), Some(Path::new("./unpacked")));

        // trailing electron args after `--`
        let c = parse(&["--", "--inspect", "--foo=bar"]);
        assert_eq!(c.run.electron_args, vec!["--inspect", "--foo=bar"]);

        // the one ops subcommand
        assert!(matches!(parse(&["self-update"]).cmd, Some(Cmd::SelfUpdate)));
    }
}
