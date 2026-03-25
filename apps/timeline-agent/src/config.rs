//! Loads the timeline agent configuration from TOML and provides safe defaults.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const DEFAULT_CONFIG_PATH: &str = "config/timeline-agent.toml";
const LEGACY_DEV_WEB_UI_URL: &str = "http://127.0.0.1:4173/#/stats";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub database_path: PathBuf,
    pub lockfile_path: PathBuf,
    pub listen_addr: String,
    pub web_ui_url: String,
    pub idle_threshold_secs: u64,
    pub poll_interval_millis: u64,
    pub debug: bool,
    pub tray_enabled: bool,
    pub record_window_titles: bool,
    pub record_page_titles: bool,
    pub ignored_apps: Vec<String>,
    pub ignored_domains: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            database_path: PathBuf::from("data/timeline.sqlite"),
            lockfile_path: PathBuf::from("data/timeline-agent.lock"),
            listen_addr: "127.0.0.1:46215".to_string(), // port chosen to avoid common conflicts
            web_ui_url: "http://127.0.0.1:46215/#/stats".to_string(),
            idle_threshold_secs: 300, // 5 minutes — standard idle detection threshold
            poll_interval_millis: 1_000, // 1 second — balances responsiveness vs CPU cost
            debug: true,
            tray_enabled: true,
            record_window_titles: true,
            record_page_titles: true,
            ignored_apps: Vec::new(),
            ignored_domains: Vec::new(),
        }
    }
}

impl AppConfig {
    pub fn load(explicit_path: Option<PathBuf>) -> Result<(Self, PathBuf)> {
        let has_explicit_path = explicit_path.is_some();
        let runtime_root = discover_runtime_root()?;
        let path = resolve_config_path(explicit_path, &runtime_root)?;

        if !path.exists() {
            let mut config = Self::default();
            let defaults_base_dir = if has_explicit_path {
                path.parent().unwrap_or(Path::new("."))
            } else {
                runtime_root.as_path()
            };
            config.resolve_relative_paths(defaults_base_dir);
            return Ok((config, path));
        }

        let content =
            std::fs::read_to_string(&path).with_context(|| format!("failed to read {:?}", path))?;
        let mut config: Self =
            toml::from_str(&content).with_context(|| format!("failed to parse {:?}", path))?;

        if !content.contains("web_ui_url") || config.web_ui_url == LEGACY_DEV_WEB_UI_URL {
            config.web_ui_url = config.self_hosted_web_ui_url();
        }

        config.resolve_relative_paths(path.parent().unwrap_or(Path::new(".")));

        Ok((config, path))
    }

    pub fn ensure_parent_dirs(&self) -> Result<()> {
        ensure_parent(&self.database_path)?;
        ensure_parent(&self.lockfile_path)?;
        Ok(())
    }

    pub fn save_to_path(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create config directory for {:?}", path))?;
        }

        let content = toml::to_string_pretty(self).context("failed to serialize config")?;
        std::fs::write(path, content)
            .with_context(|| format!("failed to write config to {:?}", path))?;
        Ok(())
    }

    pub fn effective_web_ui_url(&self) -> String {
        if self.web_ui_url.trim().is_empty()
            || self.web_ui_url == LEGACY_DEV_WEB_UI_URL
            || self.web_ui_url == Self::default().web_ui_url
        {
            return self.self_hosted_web_ui_url();
        }

        self.web_ui_url.clone()
    }

    /// Searches common locations for the built web-ui `dist/` directory.
    ///
    /// Priority order:
    ///   1. Paths relative to the running executable and its parent directories.
    ///   2. Paths relative to CWD (`apps/web-ui/dist`, `web-ui/dist`, `dist`).
    ///
    /// Returns the first candidate containing `index.html`, or `None` if the
    /// frontend hasn't been built yet.
    pub fn web_ui_dist_dir(&self) -> Option<PathBuf> {
        let current_dir = std::env::current_dir().ok();
        let current_exe = std::env::current_exe().ok();

        web_ui_dist_candidates(current_dir.as_deref(), current_exe.as_deref())
            .into_iter()
            .find(|dir| dir.join("index.html").is_file())
    }

    fn self_hosted_web_ui_url(&self) -> String {
        let (host, port) = match self.listen_addr.rsplit_once(':') {
            Some((host, port)) => (normalize_host(host), port.trim()),
            None => ("127.0.0.1".to_string(), "46215"),
        };

        format!("http://{host}:{port}/#/stats")
    }

    fn resolve_relative_paths(&mut self, runtime_root: &Path) {
        self.database_path = resolve_path(runtime_root, &self.database_path);
        self.lockfile_path = resolve_path(runtime_root, &self.lockfile_path);
    }
}

/// Normalizes a listen address host for use in self-hosted URLs.
/// Strips IPv6 brackets, maps wildcard addresses (`0.0.0.0`, `::`) to `127.0.0.1`,
/// and re-wraps bare IPv6 addresses in brackets for URL formatting.
fn normalize_host(host: &str) -> String {
    let trimmed = host.trim().trim_start_matches('[').trim_end_matches(']');
    let normalized = match trimmed {
        "" | "0.0.0.0" | "::" => "127.0.0.1".to_string(),
        value => value.to_string(),
    };

    if normalized.contains(':') {
        format!("[{normalized}]")
    } else {
        normalized
    }
}

fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create parent directory for {:?}", path))?;
    }

    Ok(())
}

fn resolve_config_path(explicit_path: Option<PathBuf>, runtime_root: &Path) -> Result<PathBuf> {
    match explicit_path {
        Some(path) => absolutize_from(std::env::current_dir()?, path),
        None => Ok(runtime_root.join(DEFAULT_CONFIG_PATH)),
    }
}

fn discover_runtime_root() -> Result<PathBuf> {
    let current_dir = std::env::current_dir().context("failed to read current directory")?;
    let exe_candidates = current_exe_parent_candidates();

    for candidate in &exe_candidates {
        if looks_like_runtime_root(candidate) {
            return Ok(candidate.clone());
        }
    }

    if let Some(exe_dir) = exe_candidates.first() {
        return Ok(exe_dir.clone());
    }

    for candidate in parent_candidates(&current_dir) {
        if looks_like_runtime_root(&candidate) {
            return Ok(candidate);
        }
    }

    Ok(current_dir)
}

fn current_exe_parent_candidates() -> Vec<PathBuf> {
    if let Ok(current_exe) = std::env::current_exe()
        && let Some(exe_dir) = current_exe.parent()
    {
        return parent_candidates(exe_dir);
    }

    Vec::new()
}

fn parent_candidates(base: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![base.to_path_buf()];

    if let Some(parent) = base.parent() {
        candidates.push(parent.to_path_buf());

        if let Some(grandparent) = parent.parent() {
            candidates.push(grandparent.to_path_buf());
        }
    }

    candidates
}

fn web_ui_dist_candidates(current_dir: Option<&Path>, current_exe: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(exe_dir) = current_exe.and_then(Path::parent) {
        push_unique(&mut candidates, exe_dir.join("web-ui/dist"));
        push_unique(&mut candidates, exe_dir.join("dist"));

        if let Some(parent) = exe_dir.parent() {
            push_unique(&mut candidates, parent.join("web-ui/dist"));
            push_unique(&mut candidates, parent.join("dist"));

            if let Some(grandparent) = parent.parent() {
                push_unique(&mut candidates, grandparent.join("apps/web-ui/dist"));
            }
        }
    }

    if let Some(current_dir) = current_dir {
        push_unique(&mut candidates, current_dir.join("apps/web-ui/dist"));
        push_unique(&mut candidates, current_dir.join("web-ui/dist"));
        push_unique(&mut candidates, current_dir.join("dist"));
    }

    candidates
}

fn push_unique(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.contains(&path) {
        candidates.push(path);
    }
}

fn looks_like_runtime_root(path: &Path) -> bool {
    path.join(DEFAULT_CONFIG_PATH).is_file()
        || path.join("Cargo.toml").is_file()
        || path.join("web-ui/dist/index.html").is_file()
        || path.join("apps/web-ui").is_dir()
}

fn resolve_path(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    }
}

fn absolutize_from(base: PathBuf, path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(base.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::{AppConfig, parent_candidates, resolve_path, web_ui_dist_candidates};
    use std::path::{Path, PathBuf};

    #[test]
    fn returns_parent_candidates_in_priority_order() {
        assert_eq!(
            parent_candidates(Path::new(r"C:\Timeline\config")),
            vec![
                PathBuf::from(r"C:\Timeline\config"),
                PathBuf::from(r"C:\Timeline"),
                PathBuf::from(r"C:\"),
            ]
        );
    }

    #[test]
    fn resolves_relative_runtime_paths_against_runtime_root() {
        let mut config = AppConfig::default();
        let root = Path::new(r"C:\Timeline");

        config.resolve_relative_paths(root);

        assert_eq!(
            config.database_path,
            PathBuf::from(r"C:\Timeline\data\timeline.sqlite")
        );
        assert_eq!(
            config.lockfile_path,
            PathBuf::from(r"C:\Timeline\data\timeline-agent.lock")
        );
    }

    #[test]
    fn keeps_absolute_runtime_paths_unchanged() {
        let path = Path::new(r"D:\data\timeline.sqlite");
        assert_eq!(resolve_path(Path::new(r"C:\Timeline"), path), path);
    }

    #[test]
    fn resolves_config_relative_paths_against_config_directory() {
        assert_eq!(
            resolve_path(
                Path::new(r"C:\Timeline\config"),
                Path::new(r"..\data\timeline.sqlite"),
            ),
            PathBuf::from(r"C:\Timeline\config\..\data\timeline.sqlite")
        );
    }

    #[test]
    fn prefers_packaged_web_ui_before_working_directory() {
        let candidates = web_ui_dist_candidates(
            Some(Path::new(r"C:\Users\me\repo")),
            Some(Path::new(r"D:\Timeline\timeline-agent.exe")),
        );

        assert_eq!(
            candidates,
            vec![
                PathBuf::from(r"D:\Timeline\web-ui\dist"),
                PathBuf::from(r"D:\Timeline\dist"),
                PathBuf::from(r"D:\web-ui\dist"),
                PathBuf::from(r"D:\dist"),
                PathBuf::from(r"C:\Users\me\repo\apps\web-ui\dist"),
                PathBuf::from(r"C:\Users\me\repo\web-ui\dist"),
                PathBuf::from(r"C:\Users\me\repo\dist"),
            ]
        );
    }

    #[test]
    fn still_discovers_repo_dist_for_dev_binaries() {
        let candidates = web_ui_dist_candidates(
            Some(Path::new(r"C:\Users\me\repo")),
            Some(Path::new(
                r"C:\Users\me\repo\target\release\timeline-agent.exe",
            )),
        );

        assert_eq!(
            candidates,
            vec![
                PathBuf::from(r"C:\Users\me\repo\target\release\web-ui\dist"),
                PathBuf::from(r"C:\Users\me\repo\target\release\dist"),
                PathBuf::from(r"C:\Users\me\repo\target\web-ui\dist"),
                PathBuf::from(r"C:\Users\me\repo\target\dist"),
                PathBuf::from(r"C:\Users\me\repo\apps\web-ui\dist"),
                PathBuf::from(r"C:\Users\me\repo\web-ui\dist"),
                PathBuf::from(r"C:\Users\me\repo\dist"),
            ]
        );
    }
}
