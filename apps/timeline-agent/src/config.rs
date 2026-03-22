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
            listen_addr: "127.0.0.1:46215".to_string(),
            web_ui_url: "http://127.0.0.1:46215/#/stats".to_string(),
            idle_threshold_secs: 300,
            poll_interval_millis: 1_000,
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
        let path = resolve_config_path(explicit_path)?;
        let runtime_root = runtime_root_from_config_path(&path);

        if !path.exists() {
            let mut config = Self::default();
            config.resolve_relative_paths(&runtime_root);
            return Ok((config, path));
        }

        let content =
            std::fs::read_to_string(&path).with_context(|| format!("failed to read {:?}", path))?;
        let mut config: Self =
            toml::from_str(&content).with_context(|| format!("failed to parse {:?}", path))?;

        if !content.contains("web_ui_url") || config.web_ui_url == LEGACY_DEV_WEB_UI_URL {
            config.web_ui_url = config.self_hosted_web_ui_url();
        }

        config.resolve_relative_paths(&runtime_root);

        Ok((config, path))
    }

    pub fn ensure_parent_dirs(&self) -> Result<()> {
        ensure_parent(&self.database_path)?;
        ensure_parent(&self.lockfile_path)?;
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

    pub fn web_ui_dist_dir(&self) -> Option<PathBuf> {
        let mut candidates = vec![
            PathBuf::from("apps/web-ui/dist"),
            PathBuf::from("web-ui/dist"),
            PathBuf::from("dist"),
        ];

        if let Ok(current_exe) = std::env::current_exe()
            && let Some(exe_dir) = current_exe.parent()
        {
            candidates.push(exe_dir.join("web-ui/dist"));
            candidates.push(exe_dir.join("dist"));

            if let Some(parent) = exe_dir.parent() {
                candidates.push(parent.join("web-ui/dist"));
                candidates.push(parent.join("dist"));

                if let Some(grandparent) = parent.parent() {
                    candidates.push(grandparent.join("apps/web-ui/dist"));
                }
            }
        }

        candidates
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

fn resolve_config_path(explicit_path: Option<PathBuf>) -> Result<PathBuf> {
    match explicit_path {
        Some(path) => absolutize_from(std::env::current_dir()?, path),
        None => Ok(discover_runtime_root()?.join(DEFAULT_CONFIG_PATH)),
    }
}

fn discover_runtime_root() -> Result<PathBuf> {
    let current_dir = std::env::current_dir().context("failed to read current directory")?;
    let mut candidates = vec![current_dir.clone()];

    if let Ok(current_exe) = std::env::current_exe()
        && let Some(exe_dir) = current_exe.parent()
    {
        candidates.push(exe_dir.to_path_buf());

        if let Some(parent) = exe_dir.parent() {
            candidates.push(parent.to_path_buf());

            if let Some(grandparent) = parent.parent() {
                candidates.push(grandparent.to_path_buf());
            }
        }
    }

    for candidate in candidates {
        if looks_like_runtime_root(&candidate) {
            return Ok(candidate);
        }
    }

    Ok(current_dir)
}

fn looks_like_runtime_root(path: &Path) -> bool {
    path.join(DEFAULT_CONFIG_PATH).is_file()
        || path.join("Cargo.toml").is_file()
        || path.join("web-ui/dist/index.html").is_file()
        || path.join("apps/web-ui").is_dir()
}

fn runtime_root_from_config_path(config_path: &Path) -> PathBuf {
    let Some(parent) = config_path.parent() else {
        return PathBuf::from(".");
    };

    if parent
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("config"))
    {
        return parent.parent().unwrap_or(parent).to_path_buf();
    }

    parent.to_path_buf()
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
    use super::{AppConfig, resolve_path, runtime_root_from_config_path};
    use std::path::{Path, PathBuf};

    #[test]
    fn derives_runtime_root_from_config_directory_layout() {
        let config_path = PathBuf::from(r"C:\Timeline\config\timeline-agent.toml");
        assert_eq!(
            runtime_root_from_config_path(&config_path),
            PathBuf::from(r"C:\Timeline")
        );
    }

    #[test]
    fn falls_back_to_parent_for_nonstandard_config_path() {
        let config_path = PathBuf::from(r"C:\Timeline\timeline-agent.toml");
        assert_eq!(
            runtime_root_from_config_path(&config_path),
            PathBuf::from(r"C:\Timeline")
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
}
