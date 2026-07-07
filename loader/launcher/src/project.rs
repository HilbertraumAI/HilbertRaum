//! The HilbertRaum project plugged into the shared loader lifecycle.
//!
//! [`loader_core::lifecycle`] owns the phase sequencing, the NixOS FHS-child delegation,
//! the updater + splash plumbing, the drive flush, and the apply/relaunch decisions.
//! HilbertRaum is a self-contained Electron app (RAG / embeddings / SQLite / OCR all live in
//! its own main process, and it manages its own model weights from the drive), so the only
//! product-specific work here is: mount the `app` component + the `llamacpp` / `whispercli`
//! sidecar components (the chat server + audio transcriber), point the app at the drive via
//! `HILBERTRAUM_DRIVE_ROOT` and at the sidecars via `HILBERTRAUM_LLAMACPP_DIR` /
//! `HILBERTRAUM_WHISPERCLI_DIR`, and run Electron. No daemon, no supervisor — nothing from mac-mgmt.

use std::path::PathBuf;
use std::process::Command;

use loader_core::lifecycle::{PrepareCtx, Project, SessionCtx};
use loader_core::{kill_spinner, log, pick_base, Mount};

/// `provide()` a component, unless a dev override dir is set for this `slot`
/// (`--with <slot>=<dir>`) — then link that local folder in place instead. The
/// "replace this component with this folder" logic is generic (loader-core).
use loader_core::provide_or_override as mount;

use crate::serve::{self, ControlState};
use crate::{electron_in, electron_target};

/// The host-local cache leaf dir (`~/.cache/<name>`, `%LOCALAPPDATA%\<name>`, …) — the
/// mount/tools dir + the instance lock. Single source for both the Project impl and the
/// early `main()` set (so the CLI subcommand that touches the cache agrees).
pub const CACHE_DIR_NAME: &str = "hilbertraum";

/// Export `var=<base>/<name>` when that mounted sidecar dir exists, so the app finds the
/// chat server / transcriber there. No-op when the sidecar wasn't shipped for this target.
fn export_runtime_dir(base: &std::path::Path, name: &str, var: &str) {
    let dir = base.join(name);
    if dir.is_dir() {
        std::env::set_var(var, &dir);
    }
}

/// The HilbertRaum run. The only session-scoped state is the tokio runtime hosting the
/// basic control-API server (kept alive for the session, dropped in teardown); the generic
/// run state (mounts, spinner, updater, the Electron handle) lives in
/// [`loader_core::lifecycle::Ctx`].
pub struct HilbertRaum {
    rt: Option<tokio::runtime::Runtime>,
}

impl HilbertRaum {
    pub fn new() -> Self {
        HilbertRaum { rt: None }
    }
}

impl Project for HilbertRaum {
    fn brand(&self) -> &str {
        "HilbertRaum"
    }

    fn cache_dir_name(&self) -> &str {
        CACHE_DIR_NAME
    }

    /// Mount the app component on the HOST and export the env the app inherits. On the
    /// FHS child (`ctx.in_fhs`) this only resolves the app dir from the inherited
    /// resources — the host already mounted it.
    fn prepare_mounts(&mut self, ctx: &mut PrepareCtx) -> bool {
        if ctx.in_fhs {
            if let Some(res) = ctx.resources {
                let a = res.join("app");
                if a.exists() {
                    *ctx.app_dir = Some(a);
                }
                // The host already mounted the sidecars into `res`; just point the app at
                // them (the FHS child spawns Electron, so the env must be set HERE too).
                export_runtime_dir(res, "llamacpp", "HILBERTRAUM_LLAMACPP_DIR");
                export_runtime_dir(res, "whispercli", "HILBERTRAUM_WHISPERCLI_DIR");
            }
            return true;
        }
        let Some(comp) = ctx.comp else { return true };
        let (dist, tools, force_extract) = (ctx.dist, ctx.tools, ctx.force_extract);

        // The Electron app ships as the single `app-<os>` component: mount/link it and run
        // Electron from the mounted tree. Dev override (`--start-with-electron DIR` →
        // HILBERTRAUM_APP_DIR): use a local unpacked app tree instead of the component.
        if let Some(dir) = std::env::var_os("HILBERTRAUM_APP_DIR").map(PathBuf::from) {
            if dir.is_dir() {
                log(&format!("app: dev override — {}", dir.display()));
                *ctx.app_dir = Some(dir);
            } else {
                log(&format!("app: HILBERTRAUM_APP_DIR {} is not a directory — ignoring", dir.display()));
                return false;
            }
        } else if let Some(app) = pick_base(comp, "app-") {
            match mount(comp, &app, &dist.join("app"), "app", tools, force_extract) {
                Ok(k) => {
                    ctx.mounts.push(Mount { dest: dist.join("app"), kind: k });
                    *ctx.app_dir = Some(dist.join("app"));
                }
                Err(e) => {
                    log(&format!("app: {e}"));
                    return false;
                }
            }
        } else {
            log("no app-<os> component found in the pool");
            return false;
        }

        // Mount the sidecar runtime components (llama.cpp chat server, whisper.cpp
        // transcriber) beside the app when present in the pool, and export their dirs so the
        // app spawns the binaries from there. Best-effort: a missing/failed sidecar is logged
        // and the app falls back (drive `runtime/`, else mock runtime / no transcriber).
        for (prefix, name, var) in [
            ("llamacpp-", "llamacpp", "HILBERTRAUM_LLAMACPP_DIR"),
            ("whispercli-", "whispercli", "HILBERTRAUM_WHISPERCLI_DIR"),
        ] {
            let Some(base) = pick_base(comp, prefix) else { continue };
            let dest = dist.join(name);
            match mount(comp, &base, &dest, name, tools, force_extract) {
                Ok(k) => {
                    ctx.mounts.push(Mount { dest: dest.clone(), kind: k });
                    std::env::set_var(var, &dest);
                }
                Err(e) => log(&format!("{name}: {e} — app will fall back")),
            }
        }

        // The loader framework's resource-tree env: consumed by the NixOS FHS sandbox
        // bind and by a relaunched launcher. These PLANAI_* names are loader-core's
        // internal contract (the shared engine predates the rebrand), not HilbertRaum's.
        std::env::set_var("PLANAI_RESOURCES", dist);
        std::env::set_var("PLANAI_COMPONENTS", comp);
        true
    }

    /// The session: point HilbertRaum at the drive and run Electron until it quits (or
    /// `/api/update/apply` — via the shared handle — kills it to request an apply).
    fn run_session(&mut self, ctx: &mut SessionCtx) -> i32 {
        // Prefer the Electron binary inside the mounted app component; fall back to one
        // sitting beside the launcher (back-compat).
        let program = ctx.app_dir.and_then(electron_in).or_else(|| electron_target(ctx.here));
        let program = match program {
            Some(p) => p,
            None => {
                log(&format!(
                    "could not find the bundled HilbertRaum app (no app-<os> component, none beside {})",
                    ctx.here.display()
                ));
                return 1;
            }
        };

        // Point HilbertRaum at the drive so its main process finds its model weights and
        // workspace (the sidecar ENGINE binaries come from the mounted llamacpp/whispercli
        // components via HILBERTRAUM_LLAMACPP_DIR / HILBERTRAUM_WHISPERCLI_DIR, set in
        // prepare_mounts). The drive root is the portable root the loader pinned from the pool
        // (the USB root holding launchers/ + components/).
        let drive_root = loader_core::portable_root();
        std::env::set_var("HILBERTRAUM_DRIVE_ROOT", &drive_root);
        log(&format!("HILBERTRAUM_DRIVE_ROOT={}", drive_root.display()));

        // The basic control-API server + the background update predownload both run on a
        // session-scoped tokio runtime (kept in `self.rt`, dropped in teardown).
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                log(&format!("control runtime: {e} — control API unavailable"));
                return self.run_electron(&program, ctx);
            }
        };
        let port: u16 = std::env::var("HILBERTRAUM_CONTROL_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
        let state = ControlState {
            brand: "HilbertRaum",
            version: env!("CARGO_PKG_VERSION"),
            drive_root: drive_root.display().to_string(),
            spinner: ctx.spinner.clone(),
            updater: ctx.updater.clone(),
            apply_requested: ctx.apply_requested.clone(),
            app: ctx.app.clone(),
        };
        match rt.block_on(serve::serve(state, port)) {
            Ok(url) => {
                std::env::set_var("HILBERTRAUM_CONTROL_URL", &url);
                log(&format!("control API on {url}"));
            }
            Err(e) => log(&format!("control API: {e} — continuing without it")),
        }

        // First-run bootstrap: predownload a staged update in the background (applied on
        // the next launch). There is no in-app UI to trigger a manual check, so this and
        // the control API's /api/update/check are the only updater hooks.
        if ctx.bootstrap_update {
            log("no update manifest on the drive — bootstrapping from the update server");
            rt.spawn(loader_core::update::check_and_predownload(ctx.updater.clone()));
        }
        self.rt = Some(rt);

        self.run_electron(&program, ctx)
    }

    /// HilbertRaum runs no auxiliary services; drop the control-API runtime (stops the
    /// server). The lifecycle unmounts the app component around this call.
    fn teardown_session(&mut self) {
        self.rt.take();
    }
}

impl HilbertRaum {
    /// Spawn Electron into the shared handle (so the lifecycle's apply path / the control
    /// API can terminate it → this wait returns) and wait for it, returning its exit code.
    fn run_electron(&mut self, program: &std::path::Path, ctx: &mut SessionCtx) -> i32 {
        let mut cmd = Command::new(program);
        #[cfg(target_os = "linux")]
        cmd.arg("--no-sandbox"); // read-only mount can't setuid chrome-sandbox
        cmd.args(ctx.args);

        // Splash safety net: the app component is mounted and Electron is spawned, so its
        // window should paint within a few seconds. Close the splash on a short timer so it
        // can't sit over the app — HilbertRaum does not POST /api/ready to close it for us.
        {
            let h = ctx.spinner.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                kill_spinner(&h);
            });
        }

        match cmd.spawn() {
            Ok(child) => {
                *ctx.app.lock().unwrap() = Some(child);
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    let mut g = ctx.app.lock().unwrap();
                    match g.as_mut().map(|c| c.try_wait()) {
                        Some(Ok(Some(st))) => break st.code().unwrap_or(0),
                        Some(Ok(None)) => continue, // still running
                        _ => break 0,
                    }
                }
            }
            Err(e) => {
                log(&format!("failed to start {}: {e}", program.display()));
                1
            }
        }
    }
}
