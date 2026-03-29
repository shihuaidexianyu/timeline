//! Installation layout helpers for launcher/backend/updater modes.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const INSTALL_ROOT_ENV: &str = "TIMELINE_INSTALL_ROOT";
pub const EXECUTABLE_NAME: &str = "timeline.exe";
const CURRENT_VERSION_FILE: &str = "current.json";
const VERSIONS_DIR: &str = "versions";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentVersionState {
    pub current_version: String,
    #[serde(default)]
    pub previous_version: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

pub fn resolve_install_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os(INSTALL_ROOT_ENV) {
        let root = PathBuf::from(root);
        if root.is_dir() {
            return Ok(root);
        }
    }

    let current_exe = std::env::current_exe().context("failed to resolve current executable")?;
    let Some(exe_dir) = current_exe.parent() else {
        bail!("failed to resolve executable parent directory");
    };

    for candidate in exe_dir.ancestors() {
        if looks_like_install_root(candidate) {
            return Ok(candidate.to_path_buf());
        }
    }

    Ok(exe_dir.to_path_buf())
}

pub fn resolve_launcher_executable() -> Result<PathBuf> {
    Ok(launcher_executable(&resolve_install_root()?))
}

pub fn launcher_executable(install_root: &Path) -> PathBuf {
    install_root.join(EXECUTABLE_NAME)
}

pub fn current_version_path(install_root: &Path) -> PathBuf {
    install_root.join(CURRENT_VERSION_FILE)
}

pub fn versions_root(install_root: &Path) -> PathBuf {
    install_root.join(VERSIONS_DIR)
}

pub fn backend_version_dir(install_root: &Path, version: &str) -> PathBuf {
    versions_root(install_root).join(version)
}

pub fn backend_executable_for_version(install_root: &Path, version: &str) -> PathBuf {
    backend_version_dir(install_root, version).join(EXECUTABLE_NAME)
}

pub fn resolve_backend_executable(install_root: &Path) -> Result<PathBuf> {
    if let Some(state) = read_current_version(install_root)? {
        let version_exe = backend_executable_for_version(install_root, &state.current_version);
        if version_exe.is_file() {
            return Ok(version_exe);
        }
    }

    let launcher = launcher_executable(install_root);
    if launcher.is_file() {
        return Ok(launcher);
    }

    bail!(
        "failed to locate backend executable under {:?}",
        install_root
    );
}

pub fn read_current_version(install_root: &Path) -> Result<Option<CurrentVersionState>> {
    let path = current_version_path(install_root);
    if !path.is_file() {
        return Ok(None);
    }

    let bytes = std::fs::read(&path)
        .with_context(|| format!("failed to read current version {:?}", path))?;
    let state = serde_json::from_slice::<CurrentVersionState>(&bytes)
        .with_context(|| format!("failed to parse current version {:?}", path))?;
    Ok(Some(state))
}

pub fn write_current_version(install_root: &Path, state: &CurrentVersionState) -> Result<()> {
    let path = current_version_path(install_root);
    let tmp = path.with_extension("json.tmp");
    let payload =
        serde_json::to_vec_pretty(state).context("failed to serialize current version state")?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create version state parent {:?}", parent))?;
    }

    std::fs::write(&tmp, payload)
        .with_context(|| format!("failed to write temp current version {:?}", tmp))?;
    if path.exists() {
        std::fs::remove_file(&path)
            .with_context(|| format!("failed to replace existing current version {:?}", path))?;
    }
    std::fs::rename(&tmp, &path).with_context(|| {
        format!(
            "failed to move temp current version {:?} -> {:?}",
            tmp, path
        )
    })?;
    Ok(())
}

fn looks_like_install_root(path: &Path) -> bool {
    path.join("config").is_dir()
        || path.join(CURRENT_VERSION_FILE).is_file()
        || path.join(VERSIONS_DIR).is_dir()
}
