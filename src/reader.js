import localforage from 'localforage';
import ePub from 'epubjs';

// ===== 存储实例 =====
const dataStore = localforage.createInstance({ name: 'epub-reader', storeName: 'data' });
const metaStore = localforage.createInstance({ name: 'epub-reader', storeName: 'meta' });

// ===== 读取 URL 参数 =====
const bookId = new URLSearchParams(location.search).get('id');

let book = null;
let rendition = null;
let currentFontSize = 100; // 百分比
let currentTheme = 'default';
let currentSpreadMode = 'single';
let pendingNoticeResolver = null;

const themes = {
  default: { body: { background: '#f6f4ec', color: '#333333' } },
  sepia: { body: { background: '#f4ecd8', color: '#5c4b37' } },
  night: { body: { background: '#1a1a2a', color: '#c8c8c8' } },
};

// ===== DOM 引用 =====
const $ = (sel) => document.querySelector(sel);
const sidebar = $('#reader-sidebar');
const tocList = $('#toc-list');
const bookmarksList = $('#bookmarks-list');
const bookmarksEmpty = $('#bookmarks-empty');
const tocPanel = $('#toc-panel');
const bookmarksPanel = $('#bookmarks-panel');
const viewer = $('#viewer');
const loader = $('#loader');
const bookTitleDisplay = $('#book-title-display');
const chapterInfo = $('#chapter-info');
const progressInfo = $('#progress-info');
const tocBtn = $('#toc-btn');
const bookmarksBtn = $('#bookmarks-btn');
const spreadButtons = [...document.querySelectorAll('.spread-btn')];
const settingsBtn = $('#settings-btn');
const settingsPanel = $('#settings-panel');
const noticeModal = $('#notice-modal');
const noticeModalTitle = $('#notice-modal-title');
const noticeModalMessage = $('#notice-modal-message');
const noticeModalConfirm = $('#notice-modal-confirm');

// ===== 初始化 =====
async function init() {
  try {
    setupNoticeModalEvents();

    if (!bookId) { goBack(); return; }

    const arrayBuffer = await dataStore.getItem(bookId);
    if (!arrayBuffer) {
      loader.style.display = 'none';
      await showNoticeModal({
        title: '找不到书籍',
        message: '找不到书籍数据，请重新添加。',
      });
      goBack();
      return;
    }

    // 显示书名
    const allBooks = await metaStore.getItem('books') || {};
    const meta = allBooks[bookId];
    if (meta) {
      document.title = `${meta.title} - EPUB 阅读器`;
      bookTitleDisplay.textContent = meta.title;
    }

    // 恢复主题偏好
    const savedTheme = localStorage.getItem(`theme_${bookId}`) || 'default';
    applyTheme(savedTheme, false);

    // 恢复字体大小
    currentFontSize = parseInt(localStorage.getItem(`fontsize_${bookId}`) || '100', 10);

    // 恢复单双页显示偏好
    applySpreadMode(localStorage.getItem(`spread_${bookId}`) || 'single', false);

    await loadBook(arrayBuffer);
    setupControls();
  } catch (error) {
    console.error('加载 EPUB 失败:', error);
    loader.style.display = 'none';
    await showNoticeModal({
      title: '加载失败',
      message: '加载书籍失败，请重新导入后重试。',
    });
    goBack();
  }
}

async function loadBook(arrayBuffer) {
  book = ePub(arrayBuffer);
  rendition = book.renderTo(viewer, {
    width: '100%',
    height: '100%',
    spread: currentSpreadMode === 'double' ? 'always' : 'none',
  });

  rendition.hooks.content.register((contents) => {
    applyThemeToContents(contents, currentTheme);
    contents.document.addEventListener('click', () => {
      closeSidebarIfOpen();
    });
  });

  // 应用已保存字体大小
  rendition.themes.fontSize(`${currentFontSize}%`);

  // 恢复阅读进度
  const savedCfi = localStorage.getItem(`progress_${bookId}`);
  await rendition.display(savedCfi || undefined);

  // 监听位置变化
  rendition.on('relocated', (location) => {
    if (location?.start?.cfi) {
      localStorage.setItem(`progress_${bookId}`, location.start.cfi);
    }
    updateProgress(location);
    highlightTocItem(location?.start?.href);
  });

  // 键盘翻页
  const handleKey = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') rendition.prev();
    if (e.key === 'ArrowRight' || e.key === 'PageDown') rendition.next();
  };
  document.addEventListener('keyup', handleKey);
  rendition.on('keyup', handleKey);

  // 渲染目录
  book.loaded.navigation.then((nav) => {
    renderToc(nav.toc);
  });

  // 隐藏加载遮罩
  loader.style.display = 'none';
}

// ===== 目录 =====
function renderToc(toc) {
  tocList.innerHTML = '';
  toc.forEach((item) => tocList.appendChild(createTocItem(item)));
}

function createTocItem(item) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = item.label.trim();
  a.dataset.href = item.href;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    rendition.display(item.href);
    closeSidebar();
  });
  li.appendChild(a);
  if (item.subitems?.length) {
    const ul = document.createElement('ul');
    item.subitems.forEach((sub) => ul.appendChild(createTocItem(sub)));
    li.appendChild(ul);
  }
  return li;
}

function highlightTocItem(href) {
  tocList.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', href && a.dataset.href && decodeURIComponent(a.dataset.href) === decodeURIComponent(href));
  });
}

// ===== 书签 =====
async function addBookmark() {
  if (!rendition) return;
  const location = rendition.currentLocation();
  const cfi = location?.start?.cfi;
  if (!cfi) return;

  const bookmarks = JSON.parse(localStorage.getItem(`bookmarks_${bookId}`) || '[]');
  if (bookmarks.find((b) => b.cfi === cfi)) return;

  // 尝试获取当前章节名
  const chapterText = chapterInfo.textContent || `书签 ${bookmarks.length + 1}`;
  bookmarks.push({ cfi, label: chapterText, created: Date.now() });
  localStorage.setItem(`bookmarks_${bookId}`, JSON.stringify(bookmarks));
  renderBookmarks();
}

function renderBookmarks() {
  const bookmarks = JSON.parse(localStorage.getItem(`bookmarks_${bookId}`) || '[]');
  bookmarksList.innerHTML = '';

  if (bookmarks.length === 0) {
    bookmarksEmpty.style.display = 'block';
    return;
  }
  bookmarksEmpty.style.display = 'none';

  bookmarks.forEach((b) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = b.label;
    a.title = new Date(b.created).toLocaleString();
    a.addEventListener('click', (e) => { e.preventDefault(); rendition.display(b.cfi); closeSidebar(); });

    const del = document.createElement('button');
    del.className = 'del-bookmark';
    del.textContent = '✕';
    del.title = '删除书签';
    del.addEventListener('click', () => {
      const saved = JSON.parse(localStorage.getItem(`bookmarks_${bookId}`) || '[]');
      localStorage.setItem(`bookmarks_${bookId}`, JSON.stringify(saved.filter((bk) => bk.cfi !== b.cfi)));
      renderBookmarks();
    });

    li.appendChild(a);
    li.appendChild(del);
    bookmarksList.appendChild(li);
  });
}

// ===== 侧边面板 =====
function openPanel(panel) {
  if (panel === 'toc') {
    tocPanel.style.display = 'flex';
    bookmarksPanel.style.display = 'none';
  } else {
    tocPanel.style.display = 'none';
    bookmarksPanel.style.display = 'flex';
    renderBookmarks();
  }
  sidebar.classList.add('open');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  tocBtn.classList.remove('sidebar-open');
  bookmarksBtn.classList.remove('sidebar-open');
}

function closeSidebarIfOpen() {
  if (sidebar.classList.contains('open')) closeSidebar();
}

function shouldKeepSidebarOpen(target) {
  return sidebar.contains(target) || tocBtn.contains(target) || bookmarksBtn.contains(target);
}

function togglePanel(panel, btn) {
  const isOpen = sidebar.classList.contains('open');
  const isSamePanel = btn.classList.contains('sidebar-open');

  document.querySelectorAll('.active-indicator').forEach((b) => b.classList.remove('sidebar-open'));

  if (isOpen && isSamePanel) {
    closeSidebar();
  } else {
    btn.classList.add('sidebar-open');
    openPanel(panel);
  }
}

function closeSettingsPanel() {
  settingsPanel.hidden = true;
  settingsBtn.classList.remove('settings-open');
  settingsBtn.setAttribute('aria-expanded', 'false');
}

function openSettingsPanel() {
  settingsPanel.hidden = false;
  settingsBtn.classList.add('settings-open');
  settingsBtn.setAttribute('aria-expanded', 'true');
}

function toggleSettingsPanel() {
  if (settingsPanel.hidden) openSettingsPanel();
  else closeSettingsPanel();
}

// ===== 主题 =====
function applyThemeToContents(contents, themeName) {
  const theme = themes[themeName] || themes.default;
  contents.document.documentElement.style.backgroundColor = theme.body.background;
  contents.document.documentElement.style.color = theme.body.color;
  contents.css('background-color', theme.body.background, true);
  contents.css('color', theme.body.color, true);
}

function applyThemeToRendition(themeName) {
  if (!rendition) return;
  rendition.getContents().forEach((contents) => {
    applyThemeToContents(contents, themeName);
  });
}

function applyTheme(name, save = true) {
  const themeName = themes[name] ? name : 'default';
  currentTheme = themeName;
  document.body.dataset.theme = themeName;
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    const isActive = btn.dataset.theme === themeName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  applyThemeToRendition(themeName);
  if (save) localStorage.setItem(`theme_${bookId}`, themeName);
}

function applySpreadMode(mode, save = true) {
  const spreadMode = mode === 'double' ? 'double' : 'single';
  currentSpreadMode = spreadMode;

  spreadButtons.forEach((btn) => {
    const isActive = btn.dataset.spread === spreadMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  if (rendition) {
    rendition.spread(spreadMode === 'double' ? 'always' : 'none', spreadMode === 'double' ? 0 : undefined);

    if (rendition.manager?.isRendered()) {
      const currentCfi = rendition.currentLocation()?.start?.cfi || localStorage.getItem(`progress_${bookId}`) || undefined;
      if (currentCfi) rendition.display(currentCfi);
    }
  }

  if (save) localStorage.setItem(`spread_${bookId}`, spreadMode);
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

function setupNoticeModalEvents() {
  if (noticeModal.dataset.bound === 'true') return;

  noticeModalConfirm.addEventListener('click', resolveNoticeModal);
  noticeModal.addEventListener('click', (e) => {
    if (e.target === noticeModal) resolveNoticeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (!noticeModal.classList.contains('visible')) return;
    if (e.key === 'Escape' || e.key === 'Enter') resolveNoticeModal();
  });

  noticeModal.dataset.bound = 'true';
}

// ===== 进度 =====
function updateProgress(location) {
  if (!location) return;
  const { displayed } = location.start;
  if (displayed) {
    progressInfo.textContent = `第 ${displayed.page} 页 / 共 ${displayed.total} 页`;
  }

  // 尝试获取章节标题
  const tocLinks = [...tocList.querySelectorAll('a.active')];
  if (tocLinks.length) chapterInfo.textContent = tocLinks[0].textContent;
}

function goBack() { window.location.href = '/'; }

// ===== 控件事件 =====
function setupControls() {
  $('#back-btn').addEventListener('click', goBack);
  $('#prev-btn').addEventListener('click', () => rendition?.prev());
  $('#next-btn').addEventListener('click', () => rendition?.next());

  tocBtn.addEventListener('click', () => togglePanel('toc', tocBtn));
  bookmarksBtn.addEventListener('click', () => togglePanel('bookmarks', bookmarksBtn));

  $('#add-bookmark-btn').addEventListener('click', addBookmark);

  $('#font-size-up').addEventListener('click', () => {
    currentFontSize = Math.min(currentFontSize + 10, 200);
    rendition?.themes.fontSize(`${currentFontSize}%`);
    localStorage.setItem(`fontsize_${bookId}`, currentFontSize);
  });
  $('#font-size-down').addEventListener('click', () => {
    currentFontSize = Math.max(currentFontSize - 10, 60);
    rendition?.themes.fontSize(`${currentFontSize}%`);
    localStorage.setItem(`fontsize_${bookId}`, currentFontSize);
  });

  $('#font-select').addEventListener('change', (e) => {
    const val = e.target.value;
    if (val) rendition?.themes.override('font-family', val);
    else rendition?.themes.override('font-family', '');
  });

  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettingsPanel();
  });

  spreadButtons.forEach((btn) => {
    btn.addEventListener('click', () => applySpreadMode(btn.dataset.spread));
  });

  viewer.addEventListener('click', () => {
    closeSidebarIfOpen();
  });

  // 点击侧边栏外关闭
  document.addEventListener('click', (e) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) {
      closeSettingsPanel();
    }

    if (sidebar.classList.contains('open') && !shouldKeepSidebarOpen(e.target)) {
      closeSidebar();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsPanel.hidden) {
      closeSettingsPanel();
    }
  });
}

init();
