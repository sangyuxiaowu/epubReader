import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

const PENDING_PATHS_KEY = 'pending-desktop-epub-paths';

function normalizePaths(paths) {
  return [...new Set((paths || [])
    .filter((path) => typeof path === 'string')
    .map((path) => path.trim())
    .filter(Boolean))];
}

function readStoredPaths() {
  try {
    return normalizePaths(JSON.parse(sessionStorage.getItem(PENDING_PATHS_KEY) || '[]'));
  } catch (_) {
    sessionStorage.removeItem(PENDING_PATHS_KEY);
    return [];
  }
}

export function stashPendingDesktopPaths(paths) {
  const normalized = normalizePaths(paths);
  if (normalized.length === 0) {
    sessionStorage.removeItem(PENDING_PATHS_KEY);
    return;
  }
  sessionStorage.setItem(PENDING_PATHS_KEY, JSON.stringify(normalized));
}

export async function takePendingDesktopPaths() {
  const storedPaths = readStoredPaths();
  sessionStorage.removeItem(PENDING_PATHS_KEY);

  if (!isTauri()) return storedPaths;

  try {
    const nativePaths = normalizePaths(await invoke('take_window_pending_epub_paths', {
      windowLabel: getCurrentWindow().label,
    }));
    return normalizePaths([...storedPaths, ...nativePaths]);
  } catch (_) {
    return storedPaths;
  }
}

export async function registerCurrentWindowBookPath(path) {
  if (!isTauri()) return;

  await invoke('register_window_context', {
    windowLabel: getCurrentWindow().label,
    currentBookPath: typeof path === 'string' && path.trim() ? path.trim() : null,
  });
}

export async function readDesktopEpubFiles(paths) {
  const normalized = normalizePaths(paths);
  if (normalized.length === 0) return [];
  return invoke('read_epub_files', { paths: normalized });
}

export async function listenWindowDragDrop(handler) {
  if (!isTauri()) return () => {};

  return getCurrentWindow().onDragDropEvent((event) => {
    const payload = event.payload || {};
    handler({
      type: payload.type,
      paths: normalizePaths(payload.paths),
    });
  });
}

export async function listenDesktopEpubOpen(handler) {
  if (!isTauri()) return () => {};

  return listen('open-epub-files', (event) => {
    const payload = event.payload || {};
    handler({ paths: normalizePaths(payload.paths) });
  });
}