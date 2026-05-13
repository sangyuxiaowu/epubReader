use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

struct WindowRoutingState {
    pending_paths: Mutex<HashMap<String, Vec<String>>>,
    current_books: Mutex<HashMap<String, Option<String>>>,
    next_window_id: AtomicUsize,
}

impl Default for WindowRoutingState {
    fn default() -> Self {
        Self {
            pending_paths: Mutex::new(HashMap::new()),
            current_books: Mutex::new(HashMap::new()),
            next_window_id: AtomicUsize::new(1),
        }
    }
}

#[derive(Clone, Serialize)]
struct OpenFilesPayload {
    paths: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLibraryPayload {
    shelf_state: Value,
    books: Value,
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

fn normalize_path_key(path: &str) -> String {
    let normalized = path.trim().replace('/', "\\");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn canonical_epub_path(path: PathBuf) -> Option<PathBuf> {
    if !path.is_file() || !is_epub_path(&path) {
        return None;
    }

    Some(path.canonicalize().unwrap_or(path))
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

    canonical_epub_path(resolved).map(|path| path.to_string_lossy().into_owned())
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

fn default_library_payload() -> DesktopLibraryPayload {
    DesktopLibraryPayload {
        shelf_state: json!({
            "categories": [
                {
                    "id": "default",
                    "name": "默认书架",
                    "bookIds": []
                }
            ],
            "currentCategoryId": "all"
        }),
        books: json!({}),
    }
}

fn library_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取应用数据目录失败: {}", error))?;

    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建应用数据目录失败 {}: {}", directory.display(), error))?;

    Ok(directory.join("library-state.json"))
}

fn cleanup_closed_windows(app: &AppHandle) {
    let state = app.state::<WindowRoutingState>();

    {
        let mut current_books = state
            .current_books
            .lock()
            .expect("window book registry poisoned");
        current_books.retain(|label, _| app.get_webview_window(label).is_some());
    }

    {
        let mut pending_paths = state
            .pending_paths
            .lock()
            .expect("window pending path registry poisoned");
        pending_paths.retain(|label, _| app.get_webview_window(label).is_some());
    }
}

fn push_pending_paths_for_window(app: &AppHandle, window_label: &str, paths: &[String]) {
    if paths.is_empty() || window_label.is_empty() {
        return;
    }

    let state = app.state::<WindowRoutingState>();
    let mut pending_paths = state
        .pending_paths
        .lock()
        .expect("window pending path registry poisoned");
    let entry = pending_paths.entry(window_label.to_string()).or_default();

    for path in paths {
        if !entry.contains(path) {
            entry.push(path.clone());
        }
    }
}

fn focus_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn find_window_for_book(app: &AppHandle, path_key: &str) -> Option<WebviewWindow> {
    let state = app.state::<WindowRoutingState>();
    let current_books = state
        .current_books
        .lock()
        .expect("window book registry poisoned");

    let label = current_books.iter().find_map(|(label, current_book)| {
        (current_book.as_deref() == Some(path_key) && app.get_webview_window(label).is_some())
            .then(|| label.clone())
    })?;

    app.get_webview_window(&label)
}

fn find_idle_window(app: &AppHandle) -> Option<WebviewWindow> {
    let state = app.state::<WindowRoutingState>();
    let current_books = state
        .current_books
        .lock()
        .expect("window book registry poisoned");

    if let Some(main_window) = app.get_webview_window("main") {
        if !matches!(current_books.get("main"), Some(Some(_))) {
            return Some(main_window);
        }
    }

    for (label, current_book) in current_books.iter() {
        if current_book.is_none() {
            if let Some(window) = app.get_webview_window(label) {
                return Some(window);
            }
        }
    }

    None
}

fn create_idle_window(app: &AppHandle) -> Option<WebviewWindow> {
    let state = app.state::<WindowRoutingState>();
    let label = format!(
        "reader-{}",
        state.next_window_id.fetch_add(1, Ordering::SeqCst)
    );

    let window = WebviewWindowBuilder::new(app, label.clone(), WebviewUrl::App("index.html".into()))
        .title("EPUB 阅读器")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .build()
        .ok()?;

    state
        .current_books
        .lock()
        .expect("window book registry poisoned")
        .insert(label, None);

    Some(window)
}

fn route_open_paths(app: &AppHandle, paths: Vec<String>) {
    cleanup_closed_windows(app);

    if paths.is_empty() {
        if let Some(window) = app.get_webview_window("main") {
            focus_window(&window);
        }
        return;
    }

    for path in paths {
        let path_key = normalize_path_key(&path);

        if let Some(window) = find_window_for_book(app, &path_key) {
            focus_window(&window);
            continue;
        }

        if let Some(window) = find_idle_window(app) {
            push_pending_paths_for_window(app, window.label(), &[path.clone()]);
            let _ = window.emit(
                "open-epub-files",
                OpenFilesPayload {
                    paths: vec![path.clone()],
                },
            );
            focus_window(&window);
            continue;
        }

        if let Some(window) = create_idle_window(app) {
            push_pending_paths_for_window(app, window.label(), &[path]);
            focus_window(&window);
        }
    }
}

#[tauri::command]
fn load_library_state(app: AppHandle) -> Result<DesktopLibraryPayload, String> {
    let path = library_state_path(&app)?;
    if !path.exists() {
        return Ok(default_library_payload());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("读取书库状态失败 {}: {}", path.display(), error))?;

    serde_json::from_str(&content)
        .map_err(|error| format!("解析书库状态失败 {}: {}", path.display(), error))
}

#[tauri::command]
fn save_library_state(app: AppHandle, shelf_state: Value, books: Value) -> Result<(), String> {
    let path = library_state_path(&app)?;
    let temp_path = path.with_extension("json.tmp");
    let payload = DesktopLibraryPayload { shelf_state, books };
    let content = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("序列化书库状态失败: {}", error))?;

    fs::write(&temp_path, content)
        .map_err(|error| format!("写入临时书库状态失败 {}: {}", temp_path.display(), error))?;

    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("替换书库状态失败 {}: {}", path.display(), error))?;
    }

    fs::rename(&temp_path, &path)
        .map_err(|error| format!("保存书库状态失败 {}: {}", path.display(), error))?;

    Ok(())
}

#[tauri::command]
fn register_window_context(
    window_label: String,
    current_book_path: Option<String>,
    state: State<'_, WindowRoutingState>,
) {
    if window_label.trim().is_empty() {
        return;
    }

    state
        .current_books
        .lock()
        .expect("window book registry poisoned")
        .insert(
            window_label,
            current_book_path
                .filter(|path| !path.trim().is_empty())
                .map(|path| normalize_path_key(&path)),
        );
}

#[tauri::command]
fn take_window_pending_epub_paths(
    window_label: String,
    state: State<'_, WindowRoutingState>,
) -> Vec<String> {
    let mut pending_paths = state
        .pending_paths
        .lock()
        .expect("window pending path registry poisoned");

    pending_paths.remove(&window_label).unwrap_or_default()
}

#[tauri::command]
fn check_epub_path(path: String) -> bool {
    canonical_epub_path(PathBuf::from(path)).is_some()
}

fn read_epub_payload(path: String) -> Result<DesktopFilePayload, String> {
    let resolved = canonical_epub_path(PathBuf::from(&path))
        .ok_or_else(|| format!("无效的 EPUB 文件路径: {}", path))?;
    let bytes = fs::read(&resolved)
        .map_err(|error| format!("读取文件失败 {}: {}", resolved.display(), error))?;
    let file_name = resolved
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("book.epub")
        .to_string();

    Ok(DesktopFilePayload {
        path: resolved.to_string_lossy().into_owned(),
        file_name,
        bytes,
    })
}

#[tauri::command]
fn read_epub_file(path: String) -> Result<DesktopFilePayload, String> {
    read_epub_payload(path)
}

#[tauri::command]
fn read_epub_files(paths: Vec<String>) -> Result<Vec<DesktopFilePayload>, String> {
    let mut files = Vec::new();

    for path in paths {
        if let Ok(file) = read_epub_payload(path) {
            files.push(file);
        }
    }

    Ok(files)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(WindowRoutingState::default())
        .invoke_handler(tauri::generate_handler![
            load_library_state,
            save_library_state,
            register_window_context,
            take_window_pending_epub_paths,
            check_epub_path,
            read_epub_file,
            read_epub_files,
        ]);

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_dialog::init());
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let cwd = PathBuf::from(cwd);
            let paths = collect_epub_paths(&args, &cwd);
            route_open_paths(app, paths);
        }));
    }

    builder
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let paths = collect_epub_paths(&args, &cwd);
            app.state::<WindowRoutingState>()
                .current_books
                .lock()
                .expect("window book registry poisoned")
                .insert("main".to_string(), None);
            push_pending_paths_for_window(&app.handle(), "main", &paths);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
