import localforage from 'localforage';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

const metaStore = localforage.createInstance({ name: 'epub-reader', storeName: 'meta' });
const dataStore = localforage.createInstance({ name: 'epub-reader', storeName: 'data' });

const DEFAULT_CATEGORY = { id: 'default', name: '默认书架', bookIds: [] };

export const isDesktopApp = isTauri();

export function createDefaultShelfState() {
  return {
    categories: [{ ...DEFAULT_CATEGORY }],
    currentCategoryId: 'all',
  };
}

function normalizeShelfState(value) {
  const fallback = createDefaultShelfState();
  if (!value || typeof value !== 'object') return fallback;

  const categories = Array.isArray(value.categories) && value.categories.length > 0
    ? value.categories
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => ({
        id: typeof item.id === 'string' && item.id ? item.id : `cat-${index + 1}`,
        name: typeof item.name === 'string' && item.name ? item.name : `分类 ${index + 1}`,
        bookIds: Array.isArray(item.bookIds) ? item.bookIds.filter((id) => typeof id === 'string') : [],
      }))
    : [{ ...DEFAULT_CATEGORY }];

  return {
    categories,
    currentCategoryId: typeof value.currentCategoryId === 'string' && value.currentCategoryId
      ? value.currentCategoryId
      : 'all',
  };
}

export function normalizeBookPath(path) {
  if (typeof path !== 'string') return '';
  const trimmed = path.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\//g, '\\');
}

export function createBookPathKey(path) {
  const normalized = normalizeBookPath(path);
  if (!normalized) return '';
  return navigator.userAgent.includes('Windows') ? normalized.toLowerCase() : normalized;
}

export function findBookByPath(books, path) {
  const pathKey = createBookPathKey(path);
  if (!pathKey) return null;
  return Object.values(books || {}).find((book) => createBookPathKey(book?.path) === pathKey) || null;
}

export async function loadLibraryData() {
  if (!isDesktopApp) {
    return {
      state: normalizeShelfState(await metaStore.getItem('shelf-state')),
      books: await metaStore.getItem('books') || {},
    };
  }

  const payload = await invoke('load_library_state');
  return {
    state: normalizeShelfState(payload?.shelfState),
    books: payload?.books && typeof payload.books === 'object' ? payload.books : {},
  };
}

export async function saveLibraryData(state, books) {
  if (!isDesktopApp) {
    await metaStore.setItem('shelf-state', state);
    await metaStore.setItem('books', books);
    return;
  }

  await invoke('save_library_state', {
    shelfState: state,
    books,
  });
}

export async function getBookContent(book) {
  if (!book) return null;

  if (isDesktopApp && book.path) {
    const payload = await invoke('read_epub_file', { path: book.path });
    return new Uint8Array(payload.bytes).buffer;
  }

  return dataStore.getItem(book.id);
}

export async function storeImportedBookContent(id, arrayBuffer) {
  if (isDesktopApp) return;
  await dataStore.setItem(id, arrayBuffer);
}

export async function removeStoredBookContent(book) {
  if (!book) return;
  if (isDesktopApp && book.path) return;
  await dataStore.removeItem(book.id);
}

export function removeBookFromCollections(state, books, id) {
  const removedBook = books[id] || null;
  delete books[id];
  state.categories.forEach((category) => {
    category.bookIds = category.bookIds.filter((bookId) => bookId !== id);
  });
  return removedBook;
}

export async function cleanupBookClientState(id) {
  if (!id) return;
  localStorage.removeItem(`progress_${id}`);
  localStorage.removeItem(`bookmarks_${id}`);
  localStorage.removeItem(`theme_${id}`);
  localStorage.removeItem(`fontsize_${id}`);
  localStorage.removeItem(`spread_${id}`);
}

export async function checkDesktopBookPath(path) {
  if (!isDesktopApp || !path) return false;
  return invoke('check_epub_path', { path });
}

export async function pickDesktopBookPaths() {
  if (!isDesktopApp) return [];

  const selection = await open({
    title: '选择 EPUB 文件',
    multiple: true,
    directory: false,
    filters: [{ name: 'EPUB', extensions: ['epub'] }],
  });

  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}