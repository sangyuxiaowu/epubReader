import localforage from 'localforage';
import Sortable from 'sortablejs';
import ePub from 'epubjs';

// ===== 存储实例 =====
const metaStore = localforage.createInstance({ name: 'epub-reader', storeName: 'meta' });
const dataStore = localforage.createInstance({ name: 'epub-reader', storeName: 'data' });

// ===== 应用状态 =====
const DEFAULT_CAT = { id: 'default', name: '默认书架', bookIds: [] };

let state = {
  categories: [{ ...DEFAULT_CAT }],
  currentCategoryId: 'all',
};
let books = {}; // id → 书籍元数据
let sortable = null;
let contextBookId = null;
let pendingCatAction = null; // { type: 'add' } | { type: 'rename', id }
let pendingConfirmResolver = null;
let pendingNoticeResolver = null;

// ===== DOM 引用 =====
const $ = (sel) => document.querySelector(sel);
const categoryList = $('#category-list');
const bookGrid = $('#book-grid');
const emptyState = $('#empty-state');
const dropOverlay = $('#drop-overlay');
const fileInput = $('#file-input');
const addBookBtn = $('#add-book-btn');
const addCatBtn = $('#add-cat-btn');
const catModal = $('#cat-modal');
const catModalTitle = $('#cat-modal-title');
const catNameInput = $('#cat-name-input');
const catModalConfirm = $('#cat-modal-confirm');
const catModalCancel = $('#cat-modal-cancel');
const confirmModal = $('#confirm-modal');
const confirmModalTitle = $('#confirm-modal-title');
const confirmModalMessage = $('#confirm-modal-message');
const confirmModalConfirm = $('#confirm-modal-confirm');
const confirmModalCancel = $('#confirm-modal-cancel');
const noticeModal = $('#notice-modal');
const noticeModalTitle = $('#notice-modal-title');
const noticeModalMessage = $('#notice-modal-message');
const noticeModalConfirm = $('#notice-modal-confirm');
const contextMenu = $('#context-menu');
const moveToMenu = $('#move-to-menu');
const currentCatTitle = $('#current-cat-title');
const bookCount = $('#book-count');
const loadingOverlay = $('#loading-overlay');

// ===== 持久化 =====
async function loadData() {
  const savedState = await metaStore.getItem('shelf-state');
  if (savedState) state = savedState;
  const savedBooks = await metaStore.getItem('books');
  if (savedBooks) books = savedBooks;
}

async function saveData() {
  await metaStore.setItem('shelf-state', state);
  await metaStore.setItem('books', books);
}

// ===== 渲染侧边栏 =====
function renderSidebar() {
  categoryList.innerHTML = '';

  const totalCount = Object.keys(books).length;
  categoryList.appendChild(createCatItem('all', `全部书籍 (${totalCount})`, false));

  state.categories.forEach((cat) => {
    categoryList.appendChild(createCatItem(cat.id, `${cat.name} (${cat.bookIds.length})`, true));
  });

  document.querySelectorAll('.cat-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === state.currentCategoryId);
  });

  const cat = state.categories.find((c) => c.id === state.currentCategoryId);
  currentCatTitle.textContent = state.currentCategoryId === 'all' ? '全部书籍' : (cat?.name || '');
}

function createCatItem(id, label, canEdit) {
  const li = document.createElement('li');
  li.className = 'cat-item';
  li.dataset.id = id;
  li.innerHTML = `
    <span class="cat-icon">${id === 'all' ? '📚' : '📁'}</span>
    <span class="cat-name">${label}</span>
    ${canEdit ? `<div class="cat-actions">
      <button class="cat-rename" title="重命名">✏️</button>
      <button class="cat-delete" title="删除">🗑️</button>
    </div>` : ''}
  `;

  li.addEventListener('click', (e) => {
    if (e.target.classList.contains('cat-rename')) { showRenameCat(id); return; }
    if (e.target.classList.contains('cat-delete')) { deleteCat(id); return; }
    state.currentCategoryId = id;
    saveData();
    renderSidebar();
    renderBooks();
  });

  return li;
}

// ===== 渲染书籍网格 =====
function renderBooks() {
  const list = getCurrentBooks();
  bookCount.textContent = `共 ${list.length} 本`;

  if (list.length === 0) {
    emptyState.style.display = 'flex';
    bookGrid.style.display = 'none';
  } else {
    emptyState.style.display = 'none';
    bookGrid.style.display = 'grid';
    bookGrid.innerHTML = '';
    list.forEach((book) => bookGrid.appendChild(createBookCard(book)));
  }

  // 只有在真实分类（非"全部"）时启用拖拽排序
  if (sortable) { sortable.destroy(); sortable = null; }
  if (state.currentCategoryId !== 'all' && list.length > 0) {
    sortable = new Sortable(bookGrid, {
      animation: 150,
      ghostClass: 'book-ghost',
      onEnd: async () => {
        const cat = state.categories.find((c) => c.id === state.currentCategoryId);
        if (cat) {
          cat.bookIds = [...bookGrid.querySelectorAll('.book-card')].map((el) => el.dataset.id);
          await saveData();
        }
      },
    });
  }
}

function getCurrentBooks() {
  if (state.currentCategoryId === 'all') {
    return Object.values(books).sort((a, b) => b.addedAt - a.addedAt);
  }
  const cat = state.categories.find((c) => c.id === state.currentCategoryId);
  if (!cat) return [];
  return cat.bookIds.map((id) => books[id]).filter(Boolean);
}

function createBookCard(book) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.dataset.id = book.id;
  card.innerHTML = `
    <div class="book-cover">
      ${book.cover
        ? `<img src="${book.cover}" alt="${escapeHtml(book.title)}" loading="lazy">`
        : `<div class="book-cover-placeholder">📖</div>`}
      <div class="book-overlay">
        <button class="btn-read">阅读</button>
      </div>
    </div>
    <div class="book-info">
      <div class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</div>
      <div class="book-author">${escapeHtml(book.author)}</div>
    </div>
  `;

  card.querySelector('.btn-read').addEventListener('click', (e) => { e.stopPropagation(); openBook(book.id); });
  card.addEventListener('click', () => openBook(book.id));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, book.id); });

  return card;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openBook(id) {
  window.location.href = `reader.html?id=${id}`;
}

// ===== 添加书籍 =====
async function addBooks(files) {
  const epubFiles = [...files].filter((f) => f.name.toLowerCase().endsWith('.epub'));
  if (epubFiles.length === 0) return;

  loadingOverlay.style.display = 'flex';
  try {
    for (const file of epubFiles) {
      await addSingleBook(file);
    }
    renderSidebar();
    renderBooks();
  } catch (err) {
    console.error('添加书籍失败:', err);
    loadingOverlay.style.display = 'none';
    await showNoticeModal({
      title: '添加书籍失败',
      message: `添加书籍失败: ${err.message}`,
    });
  } finally {
    loadingOverlay.style.display = 'none';
  }
}

async function addSingleBook(file) {
  const arrayBuffer = await file.arrayBuffer();
  const { title, author, cover } = await extractMetadata(arrayBuffer);
  const id = crypto.randomUUID();

  books[id] = { id, title: title || file.name.replace(/\.epub$/i, ''), author, cover, fileName: file.name, addedAt: Date.now() };
  await dataStore.setItem(id, arrayBuffer);

  // 加入当前分类（"全部"模式下加入第一个分类）
  const catId = state.currentCategoryId === 'all'
    ? (state.categories[0]?.id ?? null)
    : state.currentCategoryId;

  if (catId) {
    const cat = state.categories.find((c) => c.id === catId);
    if (cat && !cat.bookIds.includes(id)) cat.bookIds.push(id);
  }

  await saveData();
}

async function extractMetadata(arrayBuffer) {
  let book = null;
  try {
    book = ePub(arrayBuffer);
    await book.ready;
    const metadata = await book.loaded.metadata;

    let cover = null;
    try {
      const coverUrl = await book.coverUrl();
      if (coverUrl) {
        const resp = await fetch(coverUrl);
        if (resp.ok) {
          const imgBlob = await resp.blob();
          cover = await blobToDataUrl(imgBlob);
        }
      }
    } catch (_) { /* 封面获取失败时忽略 */ }

    book.destroy();
    return {
      title: metadata.title || '',
      author: metadata.creator || '未知作者',
      cover,
    };
  } finally {
    book?.destroy();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ===== 删除书籍 =====
async function removeBook(id) {
  const confirmed = await showConfirmModal({
    title: '确认删除书籍',
    message: '确认从书架移除此书？',
    confirmText: '删除书籍',
  });
  if (!confirmed) return;
  delete books[id];
  state.categories.forEach((cat) => {
    cat.bookIds = cat.bookIds.filter((bid) => bid !== id);
  });
  await dataStore.removeItem(id);
  await localforage.removeItem(`progress_${id}`);
  await localforage.removeItem(`bookmarks_${id}`);
  await saveData();
  renderSidebar();
  renderBooks();
}

// ===== 移动书籍 =====
async function moveBook(bookId, toCatId) {
  state.categories.forEach((cat) => {
    cat.bookIds = cat.bookIds.filter((id) => id !== bookId);
  });
  const target = state.categories.find((c) => c.id === toCatId);
  if (target && !target.bookIds.includes(bookId)) target.bookIds.push(bookId);
  await saveData();
  renderSidebar();
  renderBooks();
}

// ===== 分类管理 =====
async function addCategory(name) {
  if (state.categories.some((cat) => cat.name === name)) return;
  const cat = { id: `cat-${Date.now()}`, name, bookIds: [] };
  state.categories.push(cat);
  await saveData();
  renderSidebar();
}

async function renameCategory(id, name) {
  const cat = state.categories.find((c) => c.id === id);
  if (!cat) return;
  if (state.categories.some((item) => item.id !== id && item.name === name)) return;
  cat.name = name;
  await saveData();
  renderSidebar();
}

async function deleteCat(id) {
  const cat = state.categories.find((c) => c.id === id);
  if (!cat) return;

  if (cat.bookIds.length > 0) {
    const confirmed = await showConfirmModal({
      title: '确认删除分类',
      message: `删除分类「${cat.name}」？\n其中 ${cat.bookIds.length} 本书将移至默认书架。`,
      confirmText: '删除分类',
    });
    if (!confirmed) return;
    const first = state.categories.find((c) => c.id !== id);
    if (first) first.bookIds.push(...cat.bookIds.filter((bid) => !first.bookIds.includes(bid)));
  } else {
    const confirmed = await showConfirmModal({
      title: '确认删除分类',
      message: `删除分类「${cat.name}」？`,
      confirmText: '删除分类',
    });
    if (!confirmed) return;
  }

  state.categories = state.categories.filter((c) => c.id !== id);
  if (state.currentCategoryId === id) state.currentCategoryId = 'all';
  await saveData();
  renderSidebar();
  renderBooks();
}

// ===== 右键菜单 =====
function showContextMenu(e, bookId) {
  hideContextMenu();
  contextBookId = bookId;

  // 构建「移动到分类」子菜单
  const currentCats = state.categories.filter((c) => {
    if (state.currentCategoryId !== 'all') return c.id !== state.currentCategoryId;
    return true;
  });
  moveToMenu.innerHTML = currentCats.length
    ? currentCats.map((c) => `<div class="ctx-item ctx-move-item" data-cat="${c.id}">${escapeHtml(c.name)}</div>`).join('')
    : '<div class="ctx-item" style="color:#aaa">无其他分类</div>';

  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.style.top = `${e.clientY}px`;
  contextMenu.classList.add('visible');
}

function hideContextMenu() {
  contextMenu.classList.remove('visible');
  contextBookId = null;
}

// ===== 弹窗 =====
function showAddCat() {
  pendingCatAction = { type: 'add' };
  catModalTitle.textContent = '新建分类';
  catNameInput.value = '';
  catModal.classList.add('visible');
  setTimeout(() => catNameInput.focus(), 60);
}

function showRenameCat(id) {
  const cat = state.categories.find((c) => c.id === id);
  pendingCatAction = { type: 'rename', id };
  catModalTitle.textContent = '重命名分类';
  catNameInput.value = cat?.name ?? '';
  catModal.classList.add('visible');
  setTimeout(() => catNameInput.focus(), 60);
}

function hideCatModal() {
  catModal.classList.remove('visible');
  pendingCatAction = null;
}

function showConfirmModal({ title, message, confirmText = '确认' }) {
  if (pendingConfirmResolver) pendingConfirmResolver(false);

  confirmModalTitle.textContent = title;
  confirmModalMessage.textContent = message;
  confirmModalConfirm.textContent = confirmText;
  confirmModal.classList.add('visible');
  setTimeout(() => confirmModalConfirm.focus(), 60);

  return new Promise((resolve) => {
    pendingConfirmResolver = resolve;
  });
}

function resolveConfirmModal(result) {
  if (!pendingConfirmResolver) return;
  const resolve = pendingConfirmResolver;
  pendingConfirmResolver = null;
  confirmModal.classList.remove('visible');
  resolve(result);
}

function showNoticeModal({ title = '提示', message, confirmText = '知道了' }) {
  if (pendingNoticeResolver) pendingNoticeResolver();

  noticeModalTitle.textContent = title;
  noticeModalMessage.textContent = message;
  noticeModalConfirm.textContent = confirmText;
  noticeModal.classList.add('visible');
  setTimeout(() => noticeModalConfirm.focus(), 60);

  return new Promise((resolve) => {
    pendingNoticeResolver = resolve;
  });
}

function resolveNoticeModal() {
  if (!pendingNoticeResolver) return;
  const resolve = pendingNoticeResolver;
  pendingNoticeResolver = null;
  noticeModal.classList.remove('visible');
  resolve();
}

async function confirmCatModal() {
  const name = catNameInput.value.trim();
  if (!name) return;
  const action = pendingCatAction;
  hideCatModal();
  if (action?.type === 'add') await addCategory(name);
  else if (action?.type === 'rename') await renameCategory(action.id, name);
}

// ===== 事件绑定 =====
function setupEvents() {
  // 添加书籍
  addBookBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { addBooks(e.target.files); fileInput.value = ''; });

  // 添加分类
  addCatBtn.addEventListener('click', showAddCat);
  catModalConfirm.addEventListener('click', confirmCatModal);
  catModalCancel.addEventListener('click', hideCatModal);
  catNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmCatModal();
    if (e.key === 'Escape') hideCatModal();
  });
  confirmModalConfirm.addEventListener('click', () => resolveConfirmModal(true));
  confirmModalCancel.addEventListener('click', () => resolveConfirmModal(false));
  noticeModalConfirm.addEventListener('click', resolveNoticeModal);

  // 文件拖拽
  let dragCounter = 0;
  document.addEventListener('dragenter', (e) => {
    const hasFile = [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file');
    if (!hasFile) return;
    dragCounter++;
    dropOverlay.classList.add('active');
  });
  document.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('active');
    if (e.dataTransfer?.files?.length) addBooks(e.dataTransfer.files);
  });

  // 右键菜单
  contextMenu.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    const moveCat = e.target.closest('[data-cat]')?.dataset.cat;
    const bookId = contextBookId;
    if (action === 'open' && bookId) { hideContextMenu(); openBook(bookId); }
    if (action === 'remove' && bookId) { hideContextMenu(); await removeBook(bookId); }
    if (moveCat && bookId) { hideContextMenu(); await moveBook(bookId, moveCat); }
  });
  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
  });

  // 点击遮罩关闭弹窗
  catModal.addEventListener('click', (e) => { if (e.target === catModal) hideCatModal(); });
  confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) resolveConfirmModal(false); });
  noticeModal.addEventListener('click', (e) => { if (e.target === noticeModal) resolveNoticeModal(); });
  document.addEventListener('keydown', (e) => {
    if (noticeModal.classList.contains('visible')) {
      if (e.key === 'Escape' || e.key === 'Enter') resolveNoticeModal();
      return;
    }
    if (!confirmModal.classList.contains('visible')) return;
    if (e.key === 'Escape') resolveConfirmModal(false);
    if (e.key === 'Enter') resolveConfirmModal(true);
  });
}

// ===== 初始化 =====
async function init() {
  await loadData();
  renderSidebar();
  renderBooks();
  setupEvents();
}

init();
