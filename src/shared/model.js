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

function normalizeState(raw, opts) {
  const primaryId = String((opts && opts.primaryId) || 'primary');
  const theme = raw && (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system')
    ? raw.theme
    : 'dark';
  const items = [];
  if (raw && Array.isArray(raw.items)) {
    for (const rawItem of raw.items) {
      const item = normalizeItem(rawItem);
      if (!item) continue;
      let displayId = rawItem && rawItem.displayId != null && String(rawItem.displayId) !== ''
        ? String(rawItem.displayId)
        : primaryId;
      let homeDisplayId = rawItem && rawItem.homeDisplayId != null && String(rawItem.homeDisplayId) !== ''
        ? String(rawItem.homeDisplayId)
        : displayId;
      if (primaryId !== 'primary') {
        if (displayId === 'primary') displayId = primaryId;
        if (homeDisplayId === 'primary') homeDisplayId = primaryId;
      }
      item.displayId = displayId;
      item.homeDisplayId = homeDisplayId;
      items.push(item);
    }
  }
  const layouts = {};
  if (raw && raw.layouts && typeof raw.layouts === 'object' && !Array.isArray(raw.layouts)) {
    for (const [key, val] of Object.entries(raw.layouts)) {
      if (!val || typeof val !== 'object') continue;
      layouts[String(key)] = {
        x: num(val.x, 0),
        y: num(val.y, 0),
        width: num(val.width, 0),
        height: num(val.height, 0)
      };
    }
  }
  return { version: 2, theme, items, layouts };
}

function boundsClose(a, b) {
  if (!a || !b) return false;
  return Math.abs(num(a.width, 0) - num(b.width, 0)) <= 5
    && Math.abs(num(a.height, 0) - num(b.height, 0)) <= 5
    && Math.abs(num(a.x, 0) - num(b.x, 0)) <= 40
    && Math.abs(num(a.y, 0) - num(b.y, 0)) <= 40;
}

function itemsForDisplay(state, displayId) {
  const id = String(displayId);
  return (state && state.items ? state.items : []).filter((item) => String(item.displayId) === id);
}

function setDisplayItems(state, displayId, items) {
  const id = String(displayId);
  const others = (state.items || []).filter((item) => String(item.displayId) !== id);
  const next = (items || []).map((raw) => {
    const item = normalizeItem(raw);
    if (!item) return null;
    item.displayId = id;
    item.homeDisplayId = raw && raw.homeDisplayId ? String(raw.homeDisplayId) : id;
    return item;
  }).filter(Boolean);
  state.items = others.concat(next);
  return state;
}

function transferItem(state, itemId, toDisplayId, x, y) {
  const item = detach(state.items, itemId);
  if (!item) return null;
  const target = String(toDisplayId);
  item.displayId = target;
  item.homeDisplayId = target;
  item.x = Number.isFinite(Number(x)) ? Number(x) : 80;
  item.y = Number.isFinite(Number(y)) ? Number(y) : 80;
  item.z = nextZ(itemsForDisplay(state, target));
  state.items.push(item);
  return item;
}

function reconcileDisplays(state, displays, primaryId) {
  const primary = String(primaryId || 'primary');
  const live = (displays || []).map((d) => ({
    id: String(d.id),
    x: num(d.bounds ? d.bounds.x : d.x, 0),
    y: num(d.bounds ? d.bounds.y : d.y, 0),
    width: num(d.bounds ? d.bounds.width : d.width, 0),
    height: num(d.bounds ? d.bounds.height : d.height, 0)
  }));
  const liveIds = new Set(live.map((d) => d.id));
  const layouts = Object.assign({}, state.layouts || {});

  const remap = {};
  const taken = new Set();
  for (const [oldId, bounds] of Object.entries(layouts)) {
    if (liveIds.has(oldId)) continue;
    const match = live.find((d) => !taken.has(d.id) && boundsClose(bounds, d));
    if (match) {
      remap[oldId] = match.id;
      taken.add(match.id);
    }
  }

  for (const item of state.items || []) {
    if (remap[item.displayId]) item.displayId = remap[item.displayId];
    if (remap[item.homeDisplayId]) item.homeDisplayId = remap[item.homeDisplayId];
  }

  for (const item of state.items || []) {
    if (item.homeDisplayId && liveIds.has(String(item.homeDisplayId))) {
      item.displayId = String(item.homeDisplayId);
    }
  }

  for (const item of state.items || []) {
    if (!liveIds.has(String(item.displayId))) {
      if (!item.homeDisplayId) item.homeDisplayId = String(item.displayId);
      item.displayId = primary;
    }
  }

  for (const [oldId, newId] of Object.entries(remap)) {
    if (layouts[oldId] && !layouts[newId]) layouts[newId] = layouts[oldId];
  }
  for (const d of live) {
    layouts[d.id] = { x: d.x, y: d.y, width: d.width, height: d.height };
  }
  state.layouts = layouts;
  state.version = 2;
  return state;
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
  itemsForDisplay,
  setDisplayItems,
  transferItem,
  reconcileDisplays,
  boundsClose,
  demoBoard,
  MIN_NOTE_W: 180,
  MIN_NOTE_H: 120,
  MIN_BLOCK_W: 240,
  MIN_BLOCK_H: 88
};


  if (typeof module !== 'undefined' && module.exports) module.exports = Model;
  if (root) root.Model = Model;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
