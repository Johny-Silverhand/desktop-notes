/* Слой — интерактивная доска заметок */
'use strict';

const api = window.sloy;
const Model = window.Model;

const boardEl = document.getElementById('board');
const toolbarEl = document.getElementById('toolbar');
const hintEl = document.getElementById('hint');
const toastEl = document.getElementById('toast');
const menuEl = document.getElementById('menu');
const wallpaperEl = document.getElementById('wallpaper');

let state = Model.normalizeState({ theme: 'dark', items: [] });
let editMode = false;
let firstRun = false;
let selectedId = null;
let undoStack = [];
let redoStack = [];
let saveTimer = null;
let toastTimer = null;
let drag = null;
let resize = null;
let dropTargetId = null;
let hintTimer = null;
const UNDO_LIMIT = 80;
const HEADER_H = 38;

const ICONS = {
  chevron: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 17v5M8 3h8l-1 7a5 5 0 1 1-6 0L8 3z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><rect x="3" y="4.5" width="4" height="4" rx="1"/><rect x="3" y="10.5" width="4" height="4" rx="1"/><path d="M4 17.5l1.2 1.2L7.5 16"/></svg>',
  bold: '<svg viewBox="0 0 24 24"><path d="M7 5h6.5a3.5 3.5 0 0 1 0 7H7V5zm0 7h7.5a3.5 3.5 0 0 1 0 7H7v-7z"/></svg>',
  italic: '<svg viewBox="0 0 24 24"><path d="M10 5h9M5 19h9M14 5l-4 14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M8 7v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/></svg>'
};

function deepClone(v) {
  return Model.cloneState(v);
}

function pushUndo() {
  undoStack.push(deepClone(state));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

function applyState(next, { record } = { record: true }) {
  if (record) pushUndo();
  state = Model.normalizeState(next);
  renderAll();
  scheduleSave();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(deepClone(state));
  state = undoStack.pop();
  renderAll();
  scheduleSave();
  toast('Отменено');
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(deepClone(state));
  state = redoStack.pop();
  renderAll();
  scheduleSave();
  toast('Повторено');
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (api && api.saveBoard) api.saveBoard(state);
  }, 280);
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

function applyTheme() {
  let theme = state.theme;
  if (theme === 'system') {
    theme = document.documentElement.dataset.systemTheme || 'dark';
  }
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function cycleTheme() {
  pushUndo();
  state.theme = state.theme === 'dark' ? 'light' : state.theme === 'light' ? 'system' : 'dark';
  applyTheme();
  scheduleSave();
  const label = state.theme === 'dark' ? 'Тёмная тема' : state.theme === 'light' ? 'Светлая тема' : 'Как в системе';
  toast(label);
}

function maxZ(siblings) {
  return Model.nextZ(siblings);
}

function boardRect() {
  return boardEl.getBoundingClientRect();
}

function parentContentEl(parentId) {
  if (!parentId) return boardEl;
  return boardEl.querySelector(`[data-id="${CSS.escape(parentId)}"] > .item-body > .block-canvas`);
}

function clientToParent(parentId, clientX, clientY) {
  const el = parentContentEl(parentId) || boardEl;
  const r = el.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

function renderAll() {
  applyTheme();
  const keep = drag && drag.ghost ? drag.id : null;
  boardEl.innerHTML = '';
  const sorted = [...state.items].sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return (a.z || 0) - (b.z || 0);
  });
  for (const item of sorted) {
    if (keep && item.id === keep) continue;
    boardEl.appendChild(renderItem(item));
  }
  if (keep && drag && drag.ghost) {
    /* ghost lives in document.body */
  }
  updateChrome();
}

function renderItem(item) {
  const el = document.createElement('div');
  el.className = 'item ' + item.type;
  el.dataset.id = item.id;
  el.dataset.type = item.type;
  el.dataset.color = item.color;
  if (item.collapsed) el.classList.add('collapsed');
  if (item.id === selectedId) el.classList.add('selected');
  el.style.left = item.x + 'px';
  el.style.top = item.y + 'px';
  el.style.width = item.w + 'px';
  if (!item.collapsed) el.style.height = item.h + 'px';
  el.style.zIndex = String((item.pinned ? 800 : 0) + (item.z || 1));

  el.appendChild(renderHeader(item));

  const body = document.createElement('div');
  body.className = 'item-body';
  if (item.type === 'note') {
    if (item.kind === 'checklist') body.appendChild(renderChecklist(item));
    else body.appendChild(renderEditor(item));
  } else {
    const canvas = document.createElement('div');
    canvas.className = 'block-canvas' + ((item.children || []).length ? '' : ' empty');
    const kids = [...(item.children || [])].sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return (a.z || 0) - (b.z || 0);
    });
    for (const child of kids) {
      if (drag && drag.id === child.id) continue;
      canvas.appendChild(renderItem(child));
    }
    body.appendChild(canvas);
  }
  el.appendChild(body);

  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  handle.title = 'Изменить размер';
  handle.addEventListener('pointerdown', (e) => startResize(e, item.id));
  el.appendChild(handle);

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    select(item.id);
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    select(item.id);
    showItemMenu(e.clientX, e.clientY, item.id);
  });

  return el;
}

function renderHeader(item) {
  const header = document.createElement('div');
  header.className = 'item-header';

  if (item.type === 'block') {
    const chev = button(ICONS.chevron, item.collapsed ? 'Развернуть' : 'Свернуть', () => toggleCollapse(item.id));
    chev.querySelector('svg').classList.add('chevron');
    header.appendChild(chev);
  } else {
    const grip = document.createElement('span');
    grip.className = 'grip';
    header.appendChild(grip);
  }

  if (item.pinned) {
    const pin = document.createElement('span');
    pin.className = 'pin-dot';
    pin.title = 'Закреплено';
    header.appendChild(pin);
  }

  if (item.type === 'block') {
    const title = document.createElement('input');
    title.className = 'item-title';
    title.value = item.title || '';
    title.maxLength = 120;
    title.spellcheck = true;
    title.addEventListener('pointerdown', (e) => e.stopPropagation());
    title.addEventListener('change', () => renameBlock(item.id, title.value));
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
      e.stopPropagation();
    });
    header.appendChild(title);
  } else {
    const spacer = document.createElement('div');
    spacer.className = 'item-title';
    spacer.style.pointerEvents = 'none';
    spacer.textContent = item.kind === 'checklist' ? 'Список' : '';
    header.appendChild(spacer);
    const checkBtn = button(ICONS.check, 'Список дел', () => toggleKind(item.id));
    if (item.kind === 'checklist') checkBtn.classList.add('active');
    header.appendChild(checkBtn);
    const bBtn = button(ICONS.bold, 'Жирный (Ctrl+B)', () => format('bold'));
    const iBtn = button(ICONS.italic, 'Курсив (Ctrl+I)', () => format('italic'));
    header.appendChild(bBtn);
    header.appendChild(iBtn);
  }

  const pinBtn = button(ICONS.pin, item.pinned ? 'Открепить' : 'Закрепить', () => togglePin(item.id));
  if (item.pinned) pinBtn.classList.add('active');
  header.appendChild(pinBtn);

  const more = button(ICONS.more, 'Ещё', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showItemMenu(r.left, r.bottom + 4, item.id);
  });
  header.appendChild(more);

  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, .item-title')) return;
    startDrag(e, item.id);
  });

  return header;
}

function button(svg, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.title = title;
  b.innerHTML = svg;
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

function renderEditor(item) {
  const ed = document.createElement('div');
  ed.className = 'note-editor';
  ed.contentEditable = 'true';
  ed.spellcheck = true;
  ed.innerHTML = sanitize(item.text || '');
  ed.addEventListener('pointerdown', (e) => e.stopPropagation());
  ed.addEventListener('input', () => {
    const found = Model.findItem(state.items, item.id);
    if (!found) return;
    found.item.text = sanitize(ed.innerHTML);
    scheduleSave();
  });
  ed.addEventListener('keydown', (e) => e.stopPropagation());
  ed.addEventListener('focus', () => select(item.id));
  return ed;
}

function renderChecklist(item) {
  const list = document.createElement('div');
  list.className = 'checklist';
  for (const row of item.checklist || []) {
    list.appendChild(renderCheckRow(item, row));
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'check-add';
  add.textContent = '+ Добавить пункт';
  add.addEventListener('pointerdown', (e) => e.stopPropagation());
  add.addEventListener('click', () => addCheckItem(item.id));
  list.appendChild(add);
  return list;
}

function renderCheckRow(item, row) {
  const wrap = document.createElement('div');
  wrap.className = 'check-row' + (row.done ? ' done' : '');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!row.done;
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    pushUndo();
    const found = Model.findItem(state.items, item.id);
    const r = found && found.item.checklist.find((c) => c.id === row.id);
    if (r) r.done = box.checked;
    scheduleSave();
    wrap.classList.toggle('done', box.checked);
  });
  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'check-text';
  text.value = row.text || '';
  text.placeholder = 'Пункт…';
  text.addEventListener('pointerdown', (e) => e.stopPropagation());
  text.addEventListener('change', () => {
    const found = Model.findItem(state.items, item.id);
    const r = found && found.item.checklist.find((c) => c.id === row.id);
    if (r) r.text = text.value;
    scheduleSave();
  });
  text.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      addCheckItem(item.id, row.id);
    } else if (e.key === 'Backspace' && !text.value) {
      e.preventDefault();
      removeCheckItem(item.id, row.id);
    }
  });
  wrap.appendChild(box);
  wrap.appendChild(text);
  return wrap;
}

const ALLOWED = new Set(['B', 'I', 'STRONG', 'EM', 'BR', 'DIV', 'P', 'SPAN', 'UL', 'OL', 'LI', 'U']);

function sanitize(html) {
  const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
  const root = doc.body.firstChild;
  cleanNode(root);
  return root ? root.innerHTML : '';
}

function cleanNode(node) {
  if (!node) return;
  const children = [...node.childNodes];
  for (const child of children) {
    if (child.nodeType === 8) { child.remove(); continue; }
    if (child.nodeType === 1) {
      if (!ALLOWED.has(child.tagName)) {
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
      cleanNode(child);
    }
  }
}

function format(cmd) {
  document.execCommand(cmd, false, null);
  const found = selectedId && Model.findItem(state.items, selectedId);
  if (found && found.item.type === 'note' && found.item.kind === 'text') {
    const ed = boardEl.querySelector(`[data-id="${CSS.escape(selectedId)}"] .note-editor`);
    if (ed) {
      found.item.text = sanitize(ed.innerHTML);
      scheduleSave();
    }
  }
}

function select(id) {
  selectedId = id;
  boardEl.querySelectorAll('.item.selected').forEach((n) => n.classList.remove('selected'));
  if (id) {
    const el = boardEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) el.classList.add('selected');
    const found = Model.findItem(state.items, id);
    if (found) {
      found.item.z = maxZ(found.siblings);
      el && (el.style.zIndex = String((found.item.pinned ? 800 : 0) + found.item.z));
    }
  }
}

function toggleCollapse(id) {
  pushUndo();
  const found = Model.findItem(state.items, id);
  if (found && found.item.type === 'block') {
    found.item.collapsed = !found.item.collapsed;
    renderAll();
    scheduleSave();
  }
}

function renameBlock(id, title) {
  const found = Model.findItem(state.items, id);
  if (!found) return;
  const next = title.trim().slice(0, 120) || 'Блок';
  if (found.item.title === next) return;
  pushUndo();
  found.item.title = next;
  scheduleSave();
}

function togglePin(id) {
  pushUndo();
  const found = Model.findItem(state.items, id);
  if (!found) return;
  found.item.pinned = !found.item.pinned;
  found.item.z = maxZ(found.siblings);
  renderAll();
  scheduleSave();
}

function toggleKind(id) {
  pushUndo();
  const found = Model.findItem(state.items, id);
  if (!found || found.item.type !== 'note') return;
  const item = found.item;
  if (item.kind === 'checklist') {
    item.kind = 'text';
    if (!item.text && item.checklist.length) {
      item.text = item.checklist.map((r) => '<p>' + escapeHtml(r.text) + '</p>').join('');
    }
  } else {
    item.kind = 'checklist';
    if (!item.checklist.length) {
      const tmp = document.createElement('div');
      tmp.innerHTML = sanitize(item.text || '');
      const lines = (tmp.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
      item.checklist = (lines.length ? lines : ['']).map((text) => ({
        id: Model.uid(),
        text,
        done: false
      }));
    }
  }
  renderAll();
  scheduleSave();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function addCheckItem(noteId, afterId) {
  pushUndo();
  const found = Model.findItem(state.items, noteId);
  if (!found) return;
  const row = { id: Model.uid(), text: '', done: false };
  const list = found.item.checklist || (found.item.checklist = []);
  const idx = afterId ? list.findIndex((r) => r.id === afterId) : -1;
  if (idx >= 0) list.splice(idx + 1, 0, row);
  else list.push(row);
  renderAll();
  scheduleSave();
  requestAnimationFrame(() => {
    const rows = boardEl.querySelectorAll(`[data-id="${CSS.escape(noteId)}"] .check-text`);
    const i = idx >= 0 ? idx + 1 : rows.length - 1;
    if (rows[i]) rows[i].focus();
  });
}

function removeCheckItem(noteId, rowId) {
  const found = Model.findItem(state.items, noteId);
  if (!found) return;
  pushUndo();
  found.item.checklist = (found.item.checklist || []).filter((r) => r.id !== rowId);
  if (!found.item.checklist.length) {
    found.item.checklist.push({ id: Model.uid(), text: '', done: false });
  }
  renderAll();
  scheduleSave();
}

function setColor(id, color) {
  pushUndo();
  const found = Model.findItem(state.items, id);
  if (!found) return;
  found.item.color = color;
  renderAll();
  scheduleSave();
}

function deleteItem(id) {
  const found = Model.findItem(state.items, id);
  if (!found) return;
  pushUndo();
  const el = boardEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  found.siblings.splice(found.index, 1);
  if (selectedId === id) selectedId = null;
  if (el) {
    el.classList.add('leaving');
    setTimeout(() => { renderAll(); scheduleSave(); }, 240);
  } else {
    renderAll();
    scheduleSave();
  }
  toast('Удалено · Ctrl+Z отменит');
}

function newNote(x, y, parentId) {
  pushUndo();
  const note = Model.defaultNote(x, y);
  const colors = Model.COLORS.filter((c) => c !== 'graphite');
  note.color = colors[Math.floor(Math.random() * colors.length)];
  insertAt(note, parentId);
  selectedId = note.id;
  renderAll();
  scheduleSave();
  requestAnimationFrame(() => {
    const ed = boardEl.querySelector(`[data-id="${CSS.escape(note.id)}"] .note-editor`);
    if (ed) ed.focus();
  });
}

function newBlock(x, y, parentId) {
  pushUndo();
  const block = Model.defaultBlock(x, y);
  insertAt(block, parentId);
  selectedId = block.id;
  renderAll();
  scheduleSave();
  requestAnimationFrame(() => {
    const title = boardEl.querySelector(`[data-id="${CSS.escape(block.id)}"] .item-title`);
    if (title) { title.focus(); title.select(); }
  });
}

function insertAt(item, parentId) {
  if (parentId) {
    const found = Model.findItem(state.items, parentId);
    if (found && found.item.type === 'block') {
      found.item.children = found.item.children || [];
      item.z = maxZ(found.item.children);
      found.item.children.push(item);
      found.item.collapsed = false;
      return;
    }
  }
  item.z = maxZ(state.items);
  state.items.push(item);
}

function startDrag(e, id) {
  if (resize) return;
  const found = Model.findItem(state.items, id);
  if (!found) return;
  e.preventDefault();
  e.stopPropagation();
  select(id);
  const el = boardEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const rect = el.getBoundingClientRect();
  drag = {
    id,
    parentId: found.parent ? found.parent.id : null,
    pointerId: e.pointerId,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    width: rect.width,
    height: rect.height,
    ghost: null,
    snapshot: deepClone(state)
  };
  headerCapture(e, onDragMove, onDragUp);
}

function headerCapture(e, move, up) {
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
  window.addEventListener('pointercancel', up, { once: true });
}

function liftGhost() {
  if (!drag || drag.ghost) return;
  const el = boardEl.querySelector(`[data-id="${CSS.escape(drag.id)}"]`);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.classList.add('dragging');
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  ghost.style.position = 'fixed';
  ghost.style.zIndex = '30000';
  ghost.style.margin = '0';
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  el.style.opacity = '0.2';
  document.body.classList.add('dragging-item');
}

function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) {
    drag.moved = true;
    liftGhost();
  }
  if (drag.ghost) {
    drag.ghost.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
  }
  updateDropTarget(e.clientX, e.clientY);
}

function updateDropTarget(cx, cy) {
  boardEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  dropTargetId = null;
  const stack = document.elementsFromPoint(cx, cy);
  for (const node of stack) {
    const itemEl = node.closest && node.closest('.item.block');
    if (!itemEl) continue;
    const id = itemEl.dataset.id;
    if (id === drag.id) continue;
    const found = Model.findItem(state.items, id);
    const moving = Model.findItem(state.items, drag.id);
    if (!found || !moving) continue;
    if (Model.isDescendant(moving.item, id)) continue;
    dropTargetId = id;
    itemEl.classList.add('drop-target');
    break;
  }
}

function onDragUp(e) {
  window.removeEventListener('pointermove', onDragMove);
  if (!drag) return;
  const current = drag;
  const cx = e.clientX;
  const cy = e.clientY;
  if (current.ghost) current.ghost.remove();
  document.body.classList.remove('dragging-item');
  boardEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));

  if (!current.moved) {
    drag = null;
    dropTargetId = null;
    return;
  }

  const found = Model.findItem(state.items, current.id);
  if (!found) {
    drag = null;
    dropTargetId = null;
    renderAll();
    return;
  }

  const targetId = dropTargetId;
  dropTargetId = null;
  drag = null;

  const item = Model.detach(state.items, current.id);
  if (!item) {
    state = current.snapshot;
    renderAll();
    return;
  }

  undoStack.push(current.snapshot);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];

  if (targetId) {
    const t = Model.findItem(state.items, targetId);
    if (t && t.item.type === 'block') {
      t.item.collapsed = false;
      t.item.children = t.item.children || [];
      const pos = clientToParent(targetId, cx - current.offsetX, cy - current.offsetY);
      item.x = Math.max(8, pos.x);
      item.y = Math.max(8, pos.y);
      item.z = maxZ(t.item.children);
      t.item.children.push(item);
      renderAll();
      scheduleSave();
      return;
    }
  }

  const pos = clientToParent(null, cx - current.offsetX, cy - current.offsetY);
  item.x = pos.x;
  item.y = pos.y;
  item.z = maxZ(state.items);
  state.items.push(item);
  clampToBoard(item);
  renderAll();
  scheduleSave();
}

function clampToBoard(item) {
  const r = boardRect();
  item.x = Math.min(Math.max(-item.w + 80, item.x), r.width - 80);
  item.y = Math.min(Math.max(-20, item.y), r.height - 48);
}

function startResize(e, id) {
  e.preventDefault();
  e.stopPropagation();
  const found = Model.findItem(state.items, id);
  if (!found) return;
  pushUndo();
  resize = {
    id,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    w: found.item.w,
    h: found.item.h
  };
  document.body.classList.add('resizing');
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', onResizeUp, { once: true });
}

function onResizeMove(e) {
  if (!resize) return;
  const found = Model.findItem(state.items, resize.id);
  if (!found) return;
  const isBlock = found.item.type === 'block';
  const minW = isBlock ? Model.MIN_BLOCK_W : Model.MIN_NOTE_W;
  const minH = isBlock ? Model.MIN_BLOCK_H : Model.MIN_NOTE_H;
  found.item.w = Math.max(minW, resize.w + (e.clientX - resize.startX));
  found.item.h = Math.max(minH, resize.h + (e.clientY - resize.startY));
  const el = boardEl.querySelector(`[data-id="${CSS.escape(resize.id)}"]`);
  if (el) {
    el.style.width = found.item.w + 'px';
    el.style.height = found.item.h + 'px';
  }
}

function onResizeUp() {
  window.removeEventListener('pointermove', onResizeMove);
  document.body.classList.remove('resizing');
  resize = null;
  scheduleSave();
}

function showItemMenu(x, y, id) {
  const found = Model.findItem(state.items, id);
  if (!found) return;
  const item = found.item;
  const colors = Model.COLORS.map((c) =>
    `<button type="button" class="swatch${c === item.color ? ' active' : ''}" data-color="${c}" data-act="color" title="${c}"></button>`
  ).join('');
  menuEl.innerHTML = `
    <div class="colors">${colors}</div>
    <div class="sep"></div>
    <button type="button" data-act="pin">${item.pinned ? 'Открепить' : 'Закрепить'}</button>
    ${item.type === 'block' ? `<button type="button" data-act="collapse">${item.collapsed ? 'Развернуть' : 'Свернуть'}</button>` : ''}
    ${item.type === 'note' ? `<button type="button" data-act="kind">${item.kind === 'checklist' ? 'Обычный текст' : 'Превратить в список'}</button>` : ''}
    <button type="button" data-act="duplicate">Дублировать</button>
    <div class="sep"></div>
    <button type="button" data-act="delete" class="danger-item">Удалить</button>
  `;
  placeMenu(x, y);
  menuEl.onclick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    hideMenu();
    if (act === 'color') setColor(id, btn.dataset.color);
    if (act === 'pin') togglePin(id);
    if (act === 'collapse') toggleCollapse(id);
    if (act === 'kind') toggleKind(id);
    if (act === 'duplicate') duplicateItem(id);
    if (act === 'delete') deleteItem(id);
  };
}

function duplicateItem(id) {
  const found = Model.findItem(state.items, id);
  if (!found) return;
  pushUndo();
  const copy = deepClone(found.item);
  reId(copy);
  copy.x += 24;
  copy.y += 24;
  copy.z = maxZ(found.siblings);
  found.siblings.push(copy);
  selectedId = copy.id;
  renderAll();
  scheduleSave();
}

function reId(item) {
  item.id = Model.uid();
  if (item.checklist) item.checklist.forEach((r) => { r.id = Model.uid(); });
  if (item.children) item.children.forEach(reId);
}

function showBoardMenu(x, y) {
  menuEl.innerHTML = `
    <button type="button" data-act="note">Новая заметка <kbd>Ctrl+N</kbd></button>
    <button type="button" data-act="block">Новый блок <kbd>Ctrl+⇧+N</kbd></button>
    <div class="sep"></div>
    <button type="button" data-act="theme">Сменить тему</button>
    <button type="button" data-act="export">Экспорт копии…</button>
    <button type="button" data-act="import">Импорт копии…</button>
    <div class="sep"></div>
    <button type="button" data-act="desktop">На рабочий стол <kbd>Ctrl+Alt+N</kbd></button>
  `;
  placeMenu(x, y);
  menuEl.onclick = (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    hideMenu();
    const pos = clientToParent(null, x, y);
    if (act === 'note') newNote(pos.x - 40, pos.y - 20);
    if (act === 'block') newBlock(pos.x - 40, pos.y - 20);
    if (act === 'theme') cycleTheme();
    if (act === 'export') doExport();
    if (act === 'import') doImport();
    if (act === 'desktop') api.setEditMode(false);
  };
}

function placeMenu(x, y) {
  menuEl.hidden = false;
  menuEl.style.left = '0px';
  menuEl.style.top = '0px';
  const r = menuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 8);
  const top = Math.min(y, window.innerHeight - r.height - 8);
  menuEl.style.left = Math.max(8, left) + 'px';
  menuEl.style.top = Math.max(8, top) + 'px';
}

function hideMenu() {
  menuEl.hidden = true;
  menuEl.onclick = null;
}

async function doExport() {
  if (!api.exportBoard) return;
  const res = await api.exportBoard(state);
  if (res && res.ok) toast('Копия сохранена');
}

async function doImport() {
  if (!api.importBoard) return;
  const res = await api.importBoard();
  if (res && res.ok && res.state) {
    pushUndo();
    state = Model.normalizeState(res.state);
    renderAll();
    toast('Доска импортирована');
  }
}

let hotkey = 'Ctrl+Alt+N';
let lastIgnore = null;

function isInteractiveTarget(el) {
  if (!el || !el.closest) return false;
  return !!el.closest('.item, .toolbar, .menu, .toast, .hint, .icon-btn, button, input, textarea, .note-editor, .checklist, .resize-handle');
}

function syncIgnoreMouse(clientX, clientY) {
  if (!api || !api.ignoreMouse) return;
  if (editMode) {
    if (lastIgnore !== false) {
      api.ignoreMouse(false);
      lastIgnore = false;
    }
    return;
  }
  if (typeof clientX !== 'number' || typeof clientY !== 'number') {
    if (lastIgnore !== true) {
      api.ignoreMouse(true);
      lastIgnore = true;
    }
    return;
  }
  const ignore = !isInteractiveTarget(document.elementFromPoint(clientX, clientY));
  if (ignore !== lastIgnore) {
    api.ignoreMouse(ignore);
    lastIgnore = ignore;
  }
}

function updateChrome() {
  toolbarEl.hidden = !editMode;
  if (editMode && firstRun) {
    hintEl.hidden = false;
    hintEl.textContent = 'Двойной щелчок — новая заметка. Перетаскивайте карточки в блоки. ' + hotkey + ' или кнопка «На рабочий стол» вернут их за окна. На столе карточку можно править, просто наведя на неё курсор.';
  } else if (!editMode) {
    hintEl.hidden = true;
  }
}

function setEditModeUi(value) {
  editMode = !!value;
  document.body.classList.toggle('edit-mode', editMode);
  hideMenu();
  lastIgnore = null;
  syncIgnoreMouse();
  updateChrome();
}

function onBoardDblClick(e) {
  if (e.target.closest('.item, .toolbar, .menu, .icon-btn')) return;
  const pos = clientToParent(null, e.clientX, e.clientY);
  newNote(pos.x - 40, pos.y - 20);
}

function onKeyDown(e) {
  const inField = e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.target.tagName));
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    redo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    if (inField) format('bold');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
    if (inField) format('italic');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    const r = boardRect();
    if (e.shiftKey) newBlock(r.width / 2 - 200, r.height / 2 - 140);
    else newNote(r.width / 2 - 120, r.height / 2 - 80);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (api.saveBoard) api.saveBoard(state);
    toast('Сохранено');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    doExport();
    return;
  }
  if (e.key === 'F2' && selectedId && !inField) {
    const title = boardEl.querySelector(`[data-id="${CSS.escape(selectedId)}"] .item-title`);
    if (title && title.tagName === 'INPUT') { title.focus(); title.select(); }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !inField) {
    e.preventDefault();
    deleteItem(selectedId);
  }
  if (e.key === 'Escape') {
    if (!menuEl.hidden) { hideMenu(); return; }
    if (selectedId) { select(null); return; }
    api.setEditMode(false);
  }
}

toolbarEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const act = btn.dataset.action;
  const r = boardRect();
  if (act === 'new-note') newNote(r.width / 2 - 120, 96);
  if (act === 'new-block') newBlock(r.width / 2 - 200, 96);
  if (act === 'toggle-theme') cycleTheme();
  if (act === 'export') doExport();
  if (act === 'import') doImport();
  if (act === 'to-desktop') api.setEditMode(false);
});

boardEl.addEventListener('dblclick', onBoardDblClick);
boardEl.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.item')) return;
  e.preventDefault();
  showBoardMenu(e.clientX, e.clientY);
});
document.addEventListener('keydown', onKeyDown);
document.addEventListener('pointerdown', (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu();
});
document.addEventListener('pointermove', (e) => syncIgnoreMouse(e.clientX, e.clientY), { passive: true });
document.addEventListener('mousemove', (e) => syncIgnoreMouse(e.clientX, e.clientY), { passive: true });

if (api && api.onEditMode) {
  api.onEditMode((value) => setEditModeUi(value));
}
if (api && api.onMeta) {
  api.onMeta((meta) => {
    if (meta && meta.hotkey) hotkey = meta.hotkey;
    updateChrome();
  });
}

async function boot() {
  if (!api) {
    state = Model.demoBoard();
    firstRun = true;
    editMode = true;
    document.documentElement.classList.add('screenshot');
    wallpaperEl.hidden = false;
    renderAll();
    setEditModeUi(true);
    return;
  }
  const mode = await api.getEditMode();
  if (mode && mode.hotkey) hotkey = mode.hotkey;
  if (mode && mode.screenshot) {
    document.documentElement.classList.add('screenshot');
    wallpaperEl.hidden = false;
  }
  try {
    const sys = await api.systemTheme();
    document.documentElement.dataset.systemTheme = sys || 'dark';
  } catch (_) { /* ignore */ }
  const loaded = await api.loadBoard();
  state = Model.normalizeState(loaded.state);
  firstRun = !!loaded.firstRun;
  applyTheme();
  renderAll();
  setEditModeUi(!!(mode && mode.editMode) || !!(mode && mode.screenshot));
  if (firstRun && hintEl) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hintEl.hidden = true; firstRun = false; }, 8000);
  }
}

boot();
