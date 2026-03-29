//! GitHub Release based self-updater for the portable Windows package.

use crate::layout::{self, CurrentVersionState};
use crate::state::AgentState;
use anyhow::{Context, Result, anyhow, bail};
use reqwest::Client;
use semver::Version;
use serde::Deserialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs, time::Duration as StdDuration};
use time::OffsetDateTime;
use tokio::time::{Duration, Instant, sleep};
use tracing::{info, warn};
use zip::ZipArchive;

pub const APPLY_UPDATE_MODE_FLAG: &str = "--apply-update";

const RELEASES_LATEST_API: &str =
    "https://api.github.com/repos/shihuaidexianyu/timeline/releases/latest";
const PORTABLE_ASSET_PREFIX: &str = "timeline-portable-";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const UPDATE_HEALTH_TIMEOUT_SECS: u64 = 45;

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

struct PreparedRelease {
    release: GithubRelease,
    asset: GithubAsset,
    current_version: String,
    latest_version: String,
    has_update: bool,
}

#[derive(Debug, Clone)]
pub struct ApplyUpdateArgs {
    pub install_root: PathBuf,
    pub target_version: String,
    pub asset_url: String,
    pub asset_name: String,
    pub parent_pid: u32,
    pub listen_addr: String,
    pub restart_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    ok: bool,
    data: Option<T>,
}

#[derive(Debug, Deserialize)]
struct HealthPayload {
    service: String,
    version: String,
}

pub async fn check_for_updates() -> Result<common::AppUpdateInfo> {
    let prepared = prepare_release().await?;
    Ok(common::AppUpdateInfo {
        current_version: prepared.current_version,
        latest_version: prepared.latest_version,
        has_update: prepared.has_update,
        release_name: prepared.release.name,
        release_url: prepared.release.html_url,
        published_at: prepared.release.published_at,
        asset_name: prepared.asset.name.clone(),
    })
}

pub async fn install_latest_update(state: &AgentState) -> Result<common::InstallUpdateResponse> {
    let prepared = prepare_release().await?;
    if !prepared.has_update {
        bail!(
            "当前已经是最新版本 {}，无需重复升级",
            prepared.latest_version
        );
    }

    let install_root = layout::resolve_install_root()?;
    ensure_portable_install_root(&install_root)?;
    let current_exe = env::current_exe().context("failed to locate current executable")?;
    let restart_args = build_restart_args(state);

    spawn_updater_process(
        &current_exe,
        &ApplyUpdateArgs {
            install_root: install_root.clone(),
            target_version: prepared.latest_version.clone(),
            asset_url: prepared.asset.browser_download_url.clone(),
            asset_name: prepared.asset.name.clone(),
            parent_pid: std::process::id(),
            listen_addr: state.config().listen_addr.clone(),
            restart_args,
        },
    )?;

    info!(
        target_version = %prepared.latest_version,
        asset_name = %prepared.asset.name,
        install_root = %install_root.display(),
        "portable updater started"
    );

    Ok(common::InstallUpdateResponse {
        started: true,
        target_version: prepared.latest_version,
        release_url: prepared.release.html_url,
        asset_name: prepared.asset.name.clone(),
    })
}

pub fn parse_apply_update_args(raw_args: &[String]) -> Result<ApplyUpdateArgs> {
    let mut install_root = None;
    let mut target_version = None;
    let mut asset_url = None;
    let mut asset_name = None;
    let mut parent_pid = None;
    let mut listen_addr = None;
    let mut restart_args = Vec::new();

    let mut index = 0usize;
    while index < raw_args.len() {
        match raw_args[index].as_str() {
            "--install-root" => {
                install_root = Some(PathBuf::from(required_arg(raw_args, index + 1)?));
                index += 2;
            }
            "--target-version" => {
                target_version = Some(required_arg(raw_args, index + 1)?.to_string());
                index += 2;
            }
            "--asset-url" => {
                asset_url = Some(required_arg(raw_args, index + 1)?.to_string());
                index += 2;
            }
            "--asset-name" => {
                asset_name = Some(required_arg(raw_args, index + 1)?.to_string());
                index += 2;
            }
            "--parent-pid" => {
                parent_pid = Some(
                    required_arg(raw_args, index + 1)?
                        .parse::<u32>()
                        .context("invalid --parent-pid")?,
                );
                index += 2;
            }
            "--listen-addr" => {
                listen_addr = Some(required_arg(raw_args, index + 1)?.to_string());
                index += 2;
            }
            "--restart-arg" => {
                restart_args.push(required_arg(raw_args, index + 1)?.to_string());
                index += 2;
            }
            unknown => {
                bail!("unknown apply-update argument: {unknown}");
            }
        }
    }

    Ok(ApplyUpdateArgs {
        install_root: install_root.context("missing --install-root")?,
        target_version: target_version.context("missing --target-version")?,
        asset_url: asset_url.context("missing --asset-url")?,
        asset_name: asset_name.context("missing --asset-name")?,
        parent_pid: parent_pid.context("missing --parent-pid")?,
        listen_addr: listen_addr.unwrap_or_else(|| "127.0.0.1:46215".to_string()),
        restart_args,
    })
}

pub async fn run_apply_update(args: ApplyUpdateArgs) -> Result<()> {
    wait_for_process_exit(args.parent_pid);

    let previous_state = layout::read_current_version(&args.install_root)?;
    let previous_version = previous_state
        .as_ref()
        .map(|state| state.current_version.clone());

    let update_dir = create_update_work_dir()?;
    let zip_path = update_dir.join(&args.asset_name);
    download_asset_from_url(&args.asset_url, &args.asset_name, &zip_path).await?;

    let extract_dir = update_dir.join("expanded");
    extract_zip_archive(&zip_path, &extract_dir)?;
    let stage_root = resolve_stage_root(&extract_dir)?;

    let version_dir = layout::backend_version_dir(&args.install_root, &args.target_version);
    let staging_dir = version_dir.with_extension("staging");
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)
            .with_context(|| format!("failed to remove stale staging dir {:?}", staging_dir))?;
    }
    fs::create_dir_all(&staging_dir)
        .with_context(|| format!("failed to create staging dir {:?}", staging_dir))?;

    materialize_version_payload(&stage_root, &staging_dir)?;
    promote_version_dir(&staging_dir, &version_dir)?;
    sync_root_payload(&stage_root, &args.install_root)?;

    layout::write_current_version(
        &args.install_root,
        &CurrentVersionState {
            current_version: args.target_version.clone(),
            previous_version: previous_version.clone(),
            updated_at: Some(OffsetDateTime::now_utc().to_string()),
        },
    )?;

    start_launcher(&args.install_root, &args.restart_args)?;
    let upgraded_ok = wait_for_healthy_service(
        &args.listen_addr,
        Some(&args.target_version),
        Duration::from_secs(UPDATE_HEALTH_TIMEOUT_SECS),
    )
    .await;
    if upgraded_ok {
        info!(
            target_version = %args.target_version,
            "upgrade completed and health check passed"
        );
        return Ok(());
    }

    warn!(
        target_version = %args.target_version,
        "health check failed after upgrade, trying rollback"
    );
    if let Some(previous_version) = previous_version
        && layout::backend_executable_for_version(&args.install_root, &previous_version).is_file()
    {
        layout::write_current_version(
            &args.install_root,
            &CurrentVersionState {
                current_version: previous_version.clone(),
                previous_version: None,
                updated_at: Some(OffsetDateTime::now_utc().to_string()),
            },
        )?;
        start_launcher(&args.install_root, &args.restart_args)?;

        let rollback_ok =
            wait_for_healthy_service(&args.listen_addr, None, Duration::from_secs(20)).await;
        if rollback_ok {
            bail!(
                "new version failed health check; rolled back to {}",
                previous_version
            );
        }
    }

    bail!("new version failed health check and rollback was unsuccessful")
}

async fn prepare_release() -> Result<PreparedRelease> {
    let release = fetch_latest_release().await?;
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_version = normalize_version(&release.tag_name)?;
    let current = parse_version(&current_version)?;
    let latest = parse_version(&latest_version)?;
    let asset = select_portable_asset(&release.assets)
        .ok_or_else(|| anyhow!("latest GitHub Release does not contain a portable zip asset"))?
        .clone();

    Ok(PreparedRelease {
        release,
        asset,
        current_version,
        latest_version,
        has_update: latest > current,
    })
}

async fn fetch_latest_release() -> Result<GithubRelease> {
    let client = Client::builder()
        .user_agent(format!("timeline/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to build GitHub release client")?;

    let response = client
        .get(RELEASES_LATEST_API)
        .send()
        .await
        .context("failed to request latest GitHub Release")?;
    let response = response
        .error_for_status()
        .context("latest GitHub Release request returned an error status")?;

    response
        .json::<GithubRelease>()
        .await
        .context("failed to parse latest GitHub Release payload")
}

async fn download_asset_from_url(
    asset_url: &str,
    asset_name: &str,
    destination: &Path,
) -> Result<()> {
    let client = Client::builder()
        .user_agent(format!("timeline-updater/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to build GitHub asset download client")?;
    let response = client
        .get(asset_url)
        .send()
        .await
        .with_context(|| format!("failed to download {asset_name}"))?;
    let response = response
        .error_for_status()
        .with_context(|| format!("GitHub asset download failed for {asset_name}"))?;
    let bytes = response
        .bytes()
        .await
        .with_context(|| format!("failed to read downloaded bytes for {asset_name}"))?;

    fs::write(destination, &bytes)
        .with_context(|| format!("failed to write downloaded update zip to {:?}", destination))?;
    Ok(())
}

fn required_arg(args: &[String], index: usize) -> Result<&str> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| anyhow!("missing value for {}", args[index - 1]))
}

fn build_restart_args(state: &AgentState) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(config_path) = state.config_path() {
        args.push("--config".to_string());
        args.push(config_path.display().to_string());
    }
    args
}

fn create_update_work_dir() -> Result<PathBuf> {
    let stamp = OffsetDateTime::now_utc().unix_timestamp_nanos();
    let dir = env::temp_dir().join(format!("timeline-updater-{}-{}", std::process::id(), stamp));
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create update workspace {:?}", dir))?;
    Ok(dir)
}

fn ensure_portable_install_root(install_root: &Path) -> Result<()> {
    let has_config_dir = install_root.join("config").is_dir();
    let has_entry_exe = layout::launcher_executable(install_root).is_file();
    if has_config_dir && has_entry_exe {
        return Ok(());
    }

    bail!("在线升级仅支持 GitHub Release 解压后的便携版目录");
}

fn spawn_updater_process(current_exe: &Path, args: &ApplyUpdateArgs) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let mut command = Command::new(current_exe);
        command
            .arg(APPLY_UPDATE_MODE_FLAG)
            .arg("--install-root")
            .arg(&args.install_root)
            .arg("--target-version")
            .arg(&args.target_version)
            .arg("--asset-url")
            .arg(&args.asset_url)
            .arg("--asset-name")
            .arg(&args.asset_name)
            .arg("--parent-pid")
            .arg(args.parent_pid.to_string())
            .arg("--listen-addr")
            .arg(&args.listen_addr)
            .env(layout::INSTALL_ROOT_ENV, &args.install_root)
            .creation_flags(CREATE_NO_WINDOW);
        for arg in &args.restart_args {
            command.arg("--restart-arg").arg(arg);
        }

        command
            .spawn()
            .with_context(|| format!("failed to spawn updater process {:?}", current_exe))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(anyhow!("self update is only supported on Windows"))
}

fn wait_for_process_exit(pid: u32) {
    if pid == 0 {
        return;
    }

    let deadline = std::time::Instant::now() + StdDuration::from_secs(120);
    while std::time::Instant::now() < deadline {
        if !process_exists(pid) {
            return;
        }
        std::thread::sleep(StdDuration::from_millis(400));
    }
}

#[cfg(target_os = "windows")]
fn process_exists(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
    let Ok(handle) = handle else {
        return false;
    };
    if handle.is_invalid() {
        return false;
    }

    let _ = unsafe { CloseHandle(handle) };
    true
}

#[cfg(not(target_os = "windows"))]
fn process_exists(_pid: u32) -> bool {
    false
}

fn extract_zip_archive(zip_path: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        fs::remove_dir_all(destination)
            .with_context(|| format!("failed to clear extraction dir {:?}", destination))?;
    }
    fs::create_dir_all(destination)
        .with_context(|| format!("failed to create extraction dir {:?}", destination))?;

    let file = fs::File::open(zip_path)
        .with_context(|| format!("failed to open zip archive {:?}", zip_path))?;
    let mut archive =
        ZipArchive::new(file).with_context(|| format!("failed to read zip {:?}", zip_path))?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).with_context(|| {
            format!(
                "failed to read zip entry #{index} from archive {:?}",
                zip_path
            )
        })?;
        let Some(enclosed) = entry.enclosed_name().map(|name| destination.join(name)) else {
            continue;
        };

        if entry.is_dir() {
            fs::create_dir_all(&enclosed)
                .with_context(|| format!("failed to create extracted dir {:?}", enclosed))?;
            continue;
        }

        if let Some(parent) = enclosed.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create extracted parent {:?}", parent))?;
        }

        let mut output = fs::File::create(&enclosed)
            .with_context(|| format!("failed to create {:?}", enclosed))?;
        let mut buffer = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .with_context(|| format!("failed to read zip entry {:?}", enclosed))?;
        output
            .write_all(&buffer)
            .with_context(|| format!("failed to write extracted file {:?}", enclosed))?;
    }

    Ok(())
}

fn resolve_stage_root(extract_dir: &Path) -> Result<PathBuf> {
    let entries: Vec<std::fs::DirEntry> = fs::read_dir(extract_dir)
        .with_context(|| format!("failed to scan extraction dir {:?}", extract_dir))?
        .filter_map(|entry| entry.ok())
        .collect();

    if entries.len() == 1 && entries[0].path().is_dir() {
        return Ok(entries[0].path());
    }

    Ok(extract_dir.to_path_buf())
}

fn materialize_version_payload(stage_root: &Path, version_dir: &Path) -> Result<()> {
    let source_exe = stage_root.join(layout::EXECUTABLE_NAME);
    if !source_exe.is_file() {
        bail!(
            "update package does not contain {}",
            layout::EXECUTABLE_NAME
        );
    }
    copy_file(&source_exe, &version_dir.join(layout::EXECUTABLE_NAME))?;
    copy_dir_if_exists(&stage_root.join("web-ui"), &version_dir.join("web-ui"))?;
    copy_dir_if_exists(
        &stage_root.join("browser-extension"),
        &version_dir.join("browser-extension"),
    )?;
    Ok(())
}

fn promote_version_dir(staging_dir: &Path, version_dir: &Path) -> Result<()> {
    if version_dir.exists() {
        fs::remove_dir_all(version_dir)
            .with_context(|| format!("failed to remove previous version dir {:?}", version_dir))?;
    }
    if let Some(parent) = version_dir.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create versions root {:?}", parent))?;
    }
    fs::rename(staging_dir, version_dir)
        .with_context(|| format!("failed to promote {:?} -> {:?}", staging_dir, version_dir))?;
    Ok(())
}

fn sync_root_payload(stage_root: &Path, install_root: &Path) -> Result<()> {
    copy_file(
        &stage_root.join(layout::EXECUTABLE_NAME),
        &install_root.join(layout::EXECUTABLE_NAME),
    )?;
    copy_dir_if_exists(&stage_root.join("web-ui"), &install_root.join("web-ui"))?;
    copy_dir_if_exists(
        &stage_root.join("browser-extension"),
        &install_root.join("browser-extension"),
    )?;
    copy_file_if_exists(
        &stage_root.join("README-portable.txt"),
        &install_root.join("README-portable.txt"),
    )?;

    let config_dir = install_root.join("config");
    fs::create_dir_all(&config_dir)
        .with_context(|| format!("failed to create config dir {:?}", config_dir))?;
    copy_file_if_exists(
        &stage_root.join("config").join("timeline.example.toml"),
        &config_dir.join("timeline.example.toml"),
    )?;
    let user_config = config_dir.join("timeline.toml");
    if !user_config.exists() {
        copy_file_if_exists(
            &stage_root.join("config").join("timeline.toml"),
            &user_config,
        )?;
    }

    Ok(())
}

fn copy_file_if_exists(source: &Path, destination: &Path) -> Result<()> {
    if source.is_file() {
        copy_file(source, destination)?;
    }
    Ok(())
}

fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    let Some(parent) = destination.parent() else {
        bail!("invalid destination path: {:?}", destination);
    };
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create destination parent {:?}", parent))?;
    fs::copy(source, destination)
        .with_context(|| format!("failed to copy {:?} -> {:?}", source, destination))?;
    Ok(())
}

fn copy_dir_if_exists(source: &Path, destination: &Path) -> Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    copy_dir_recursive(source, destination)
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        fs::remove_dir_all(destination)
            .with_context(|| format!("failed to clear destination dir {:?}", destination))?;
    }
    fs::create_dir_all(destination)
        .with_context(|| format!("failed to create destination dir {:?}", destination))?;

    for entry in fs::read_dir(source).with_context(|| format!("failed to read {:?}", source))? {
        let entry = entry.with_context(|| format!("failed to access {:?}", source))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry
            .file_type()
            .with_context(|| format!("failed to inspect {:?}", source_path))?
            .is_dir()
        {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else {
            copy_file(&source_path, &destination_path)?;
        }
    }

    Ok(())
}

fn start_launcher(install_root: &Path, restart_args: &[String]) -> Result<()> {
    let launcher = layout::launcher_executable(install_root);
    if !launcher.is_file() {
        bail!("failed to locate launcher executable {:?}", launcher);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let mut command = Command::new(&launcher);
        command
            .args(restart_args)
            .current_dir(install_root)
            .env(layout::INSTALL_ROOT_ENV, install_root)
            .creation_flags(CREATE_NO_WINDOW);
        command
            .spawn()
            .with_context(|| format!("failed to restart launcher {:?}", launcher))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(anyhow!("self update is only supported on Windows"))
}

async fn wait_for_healthy_service(
    listen_addr: &str,
    expected_version: Option<&str>,
    timeout: Duration,
) -> bool {
    let health_url = format!("http://{}/health", normalize_health_addr(listen_addr));
    let client = match Client::builder().timeout(StdDuration::from_secs(3)).build() {
        Ok(client) => client,
        Err(_) => return false,
    };
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let response = client.get(&health_url).send().await;
        if let Ok(response) = response
            && let Ok(response) = response.error_for_status()
            && let Ok(payload) = response.json::<ApiEnvelope<HealthPayload>>().await
            && payload.ok
            && let Some(health) = payload.data
            && health.service == "timeline"
            && expected_version.is_none_or(|version| health.version == version)
        {
            return true;
        }

        sleep(Duration::from_secs(1)).await;
    }

    false
}

fn normalize_health_addr(listen_addr: &str) -> String {
    let trimmed = listen_addr.trim();
    if let Some((host, port)) = trimmed.rsplit_once(':') {
        let host = host.trim().trim_start_matches('[').trim_end_matches(']');
        let host = match host {
            "" | "0.0.0.0" | "::" => "127.0.0.1",
            value => value,
        };
        if host.contains(':') {
            return format!("[{host}]:{port}");
        }
        return format!("{host}:{port}");
    }

    "127.0.0.1:46215".to_string()
}

fn parse_version(value: &str) -> Result<Version> {
    Version::parse(value).with_context(|| format!("invalid semver version {value}"))
}

fn normalize_version(tag: &str) -> Result<String> {
    let trimmed = tag.trim();
    let normalized = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    Ok(parse_version(normalized)?.to_string())
}

fn select_portable_asset(assets: &[GithubAsset]) -> Option<&GithubAsset> {
    assets
        .iter()
        .find(|asset| asset.name.starts_with(PORTABLE_ASSET_PREFIX) && asset.name.ends_with(".zip"))
        .or_else(|| {
            assets
                .iter()
                .find(|asset| asset.name.ends_with(".zip") && asset.name.contains("portable"))
        })
}

#[cfg(test)]
mod tests {
    use super::{
        GithubAsset, normalize_health_addr, normalize_version, parse_apply_update_args,
        select_portable_asset,
    };
    use std::path::PathBuf;

    #[test]
    fn normalizes_versions_with_optional_v_prefix() {
        assert_eq!(normalize_version("v1.2.3").unwrap(), "1.2.3");
        assert_eq!(normalize_version("1.2.3").unwrap(), "1.2.3");
    }

    #[test]
    fn selects_portable_zip_asset() {
        let assets = vec![
            GithubAsset {
                name: "timeline-source.tar.gz".to_string(),
                browser_download_url: "https://example.com/source".to_string(),
            },
            GithubAsset {
                name: "timeline-portable-1.2.3.zip".to_string(),
                browser_download_url: "https://example.com/portable".to_string(),
            },
        ];

        assert_eq!(
            select_portable_asset(&assets).map(|asset| asset.name.as_str()),
            Some("timeline-portable-1.2.3.zip")
        );
    }

    #[test]
    fn parses_apply_update_args() {
        let args = vec![
            "--install-root".to_string(),
            r"C:\Timeline".to_string(),
            "--target-version".to_string(),
            "0.3.1".to_string(),
            "--asset-url".to_string(),
            "https://example.com/a.zip".to_string(),
            "--asset-name".to_string(),
            "timeline-portable-0.3.1.zip".to_string(),
            "--parent-pid".to_string(),
            "12345".to_string(),
            "--listen-addr".to_string(),
            "127.0.0.1:46215".to_string(),
            "--restart-arg".to_string(),
            "--config".to_string(),
            "--restart-arg".to_string(),
            r"C:\Timeline\config\timeline.toml".to_string(),
        ];

        let parsed = parse_apply_update_args(&args).unwrap();
        assert_eq!(parsed.install_root, PathBuf::from(r"C:\Timeline"));
        assert_eq!(parsed.target_version, "0.3.1");
        assert_eq!(parsed.parent_pid, 12345);
        assert_eq!(
            parsed.restart_args,
            vec!["--config", r"C:\Timeline\config\timeline.toml"]
        );
    }

    #[test]
    fn normalizes_health_addr_to_loopback() {
        assert_eq!(normalize_health_addr("0.0.0.0:46215"), "127.0.0.1:46215");
        assert_eq!(normalize_health_addr("127.0.0.1:46215"), "127.0.0.1:46215");
        assert_eq!(normalize_health_addr("[::]:46215"), "127.0.0.1:46215");
    }
}
