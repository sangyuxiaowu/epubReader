use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
struct PendingEpubPaths(Mutex<Vec<String>>);

#[derive(Clone, Serialize)]
struct OpenFilesPayload {
    paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopFilePayload {
    path: String,
    file_name: String,
    bytes: Vec<u8>,
}

fn is_epub_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("epub"))
}

fn resolve_epub_path(raw_path: &str, cwd: &Path) -> Option<String> {
    if raw_path.trim().is_empty() || raw_path.starts_with('-') {
        return None;
    }

    let candidate = PathBuf::from(raw_path);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    };

    if !resolved.is_file() || !is_epub_path(&resolved) {
        return None;
    }

    Some(resolved.to_string_lossy().into_owned())
}

fn collect_epub_paths(args: &[String], cwd: &Path) -> Vec<String> {
    let mut paths = Vec::new();

    for raw_path in args.iter().skip(1) {
        if let Some(path) = resolve_epub_path(raw_path, cwd) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }

    paths
}

fn push_pending_epub_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    let state = app.state::<PendingEpubPaths>();
    let mut pending = state.0.lock().expect("pending epub paths poisoned");

    for path in paths {
        if !pending.contains(&path) {
            pending.push(path);
        }
    }
}

#[tauri::command]
fn take_pending_epub_paths(state: State<'_, PendingEpubPaths>) -> Vec<String> {
    let mut pending = state.0.lock().expect("pending epub paths poisoned");
    std::mem::take(&mut *pending)
}

#[tauri::command]
fn read_epub_files(paths: Vec<String>) -> Result<Vec<DesktopFilePayload>, String> {
    let mut files = Vec::new();

    for path in paths {
        let resolved = PathBuf::from(&path);
        if !resolved.is_file() || !is_epub_path(&resolved) {
            continue;
        }

        let bytes = fs::read(&resolved)
            .map_err(|error| format!("读取文件失败 {}: {}", resolved.display(), error))?;
        let file_name = resolved
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("book.epub")
            .to_string();

        files.push(DesktopFilePayload {
            path,
            file_name,
            bytes,
        });
    }

    Ok(files)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(PendingEpubPaths::default())
        .invoke_handler(tauri::generate_handler![take_pending_epub_paths, read_epub_files]);

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let cwd = PathBuf::from(cwd);
            let paths = collect_epub_paths(&args, &cwd);

            push_pending_epub_paths(app, paths.clone());

            if !paths.is_empty() {
                let _ = app.emit("open-epub-files", OpenFilesPayload { paths });
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let paths = collect_epub_paths(&args, &cwd);
            push_pending_epub_paths(&app.handle(), paths);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
