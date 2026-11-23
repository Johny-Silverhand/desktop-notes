'use strict';

(function (root) {
function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function walk(items, fn, parent) {
  if (!items) return null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const stop = fn(item, parent || null, items, i);
    if (stop) return stop;
    if (item.children && item.children.length) {
      const found = walk(item.children, fn, item);
      if (found) return found;
    }
  }
  return null;
}

function findItem(items, id) {
  let found = null;
  walk(items, (item, parent, siblings, index) => {
    if (item.id === id) {
      found = { item, parent, siblings, index };
      return true;
    }
    return false;
  });
  return found;
}

function detach(items, id) {
  const found = findItem(items, id);
  if (!found) return null;
  found.siblings.splice(found.index, 1);
  return found.item;
}

function isDescendant(root, id) {
  if (!root || !root.children) return false;
  return !!walk(root.children, (item) => item.id === id);
}

function collectIds(items, into) {
  const acc = into || [];
  walk(items, (item) => {
    acc.push(item.id);
    return false;
  });
  return acc;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

const COLORS = ['graphite', 'amber', 'rose', 'violet', 'sky', 'teal', 'lime', 'coral'];

function defaultNote(x, y, extras) {
  return Object.assign({
    id: uid(),
    type: 'note',
    x: x || 80,
    y: y || 80,
    w: 250,
    h: 190,
    color: 'amber',
    pinned: false,
    kind: 'text',
    text: '',
    checklist: [],
    z: 1
  }, extras || {});
}

function defaultBlock(x, y, extras) {
  return Object.assign({
    id: uid(),
    type: 'block',
    x: x || 80,
    y: y || 80,
    w: 440,
    h: 340,
    color: 'violet',
    pinned: false,
    collapsed: false,
    title: 'Новый блок',
    children: [],
    z: 1
  }, extras || {});
}

function nextZ(siblings) {
  if (!siblings || !siblings.length) return 1;
  return siblings.reduce((m, i) => Math.max(m, i.z || 0), 0) + 1;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type === 'block' ? 'block' : 'note';
  const color = COLORS.includes(raw.color) ? raw.color : 'graphite';
  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    type,
    x: num(raw.x, 80),
    y: num(raw.y, 80),
    w: clamp(num(raw.w, type === 'block' ? 440 : 250), type === 'block' ? 240 : 180, 1600),
    h: clamp(num(raw.h, type === 'block' ? 340 : 190), type === 'block' ? 88 : 120, 1400),
    color,
    pinned: !!raw.pinned,
    z: num(raw.z, 1)
  };
  if (type === 'block') {
    base.collapsed = !!raw.collapsed;
    base.title = typeof raw.title === 'string' ? raw.title.slice(0, 120) : 'Блок';
    base.children = Array.isArray(raw.children)
      ? raw.children.map(normalizeItem).filter(Boolean)
      : [];
    return base;
  }
  base.kind = raw.kind === 'checklist' ? 'checklist' : 'text';
  base.text = typeof raw.text === 'string' ? raw.text : '';
  base.checklist = Array.isArray(raw.checklist)
    ? raw.checklist.map((row) => ({
        id: (row && row.id) || uid(),
        text: row && typeof row.text === 'string' ? row.text : '',
        done: !!(row && row.done)
      }))
    : [];
  return base;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

function normalizeState(raw) {
  const theme = raw && (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system')
    ? raw.theme
    : 'dark';
  const items = raw && Array.isArray(raw.items)
    ? raw.items.map(normalizeItem).filter(Boolean)
    : [];
  return { version: 1, theme, items };
}

function demoBoard() {
  const shopping = defaultNote(24, 48, {
    color: 'amber',
    kind: 'checklist',
    w: 260,
    h: 250,
    text: '',
    checklist: [
      { id: uid(), text: 'Молоко и хлеб', done: true },
      { id: uid(), text: 'Заказать фильтр для воды', done: false },
      { id: uid(), text: 'Забрать куртку из химчистки', done: false },
      { id: uid(), text: 'Цветы к пятнице', done: false }
    ]
  });
  const today = defaultNote(304, 48, {
    color: 'sky',
    w: 280,
    h: 210,
    text: '<p><strong>Сегодня</strong></p><p>Созвон в 11:00</p><p><em>Не забыть выгрузить отчёт.</em></p><p>Вечером — спортзал.</p>'
  });
  const todayBlock = defaultBlock(80, 70, {
    title: 'Сегодня',
    color: 'amber',
    w: 620,
    h: 370,
    children: [shopping, today]
  });

  const paint = defaultNote(24, 44, {
    color: 'coral',
    w: 230,
    h: 160,
    text: '<p>Покрасить кухню в тёплый песочный.</p><p>Образец — банка на подоконнике.</p>'
  });
  const plants = defaultNote(270, 44, {
    color: 'lime',
    w: 230,
    h: 180,
    text: '<p><strong>Растения</strong></p><p>Фикус полить в субботу.</p><p>Пересадить монстеру весной.</p>'
  });
  const home = defaultBlock(24, 48, {
    title: 'Дом',
    color: 'teal',
    w: 540,
    h: 300,
    children: [paint, plants]
  });
  const idea = defaultNote(24, 370, {
    color: 'violet',
    w: 540,
    h: 150,
    text: '<p>Идея для выходных: короткий выезд за город, термос и плед.</p>'
  });
  const ideas = defaultBlock(740, 70, {
    title: 'Идеи',
    color: 'violet',
    w: 600,
    h: 560,
    children: [home, idea]
  });

  const pin = defaultNote(80, 480, {
    color: 'rose',
    pinned: true,
    w: 280,
    h: 170,
    text: '<p><strong>Позвонить маме</strong></p><p>В воскресенье после обеда.</p>'
  });
  const quote = defaultNote(400, 500, {
    color: 'graphite',
    w: 300,
    h: 180,
    text: '<p><em>«Большие дела делаются из маленьких шагов.»</em></p>'
  });

  return {
    version: 1,
    theme: 'dark',
    items: [todayBlock, ideas, pin, quote]
  };
}

const Model = {
  uid,
  walk,
  findItem,
  detach,
  isDescendant,
  collectIds,
  cloneState,
  COLORS,
  defaultNote,
  defaultBlock,
  nextZ,
  normalizeItem,
  normalizeState,
  demoBoard,
  MIN_NOTE_W: 180,
  MIN_NOTE_H: 120,
  MIN_BLOCK_W: 240,
  MIN_BLOCK_H: 88
};


  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
  if (root) root.Model = Model;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
