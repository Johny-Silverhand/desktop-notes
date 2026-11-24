'use strict';

const assert = require('assert');
const Model = require('./model');

const board = Model.demoBoard();
assert.strictEqual(board.items.length, 4);
assert.ok(board.items.some((i) => i.type === 'block' && i.title === 'Сегодня'));
assert.ok(board.items.some((i) => i.type === 'block' && i.title === 'Идеи'));
assert.ok(board.items.some((i) => i.pinned));

const ideas = board.items.find((i) => i.title === 'Идеи');
const home = ideas.children.find((i) => i.title === 'Дом');
assert.ok(home);
assert.strictEqual(home.children.length, 2);
assert.ok(Model.isDescendant(ideas, home.children[0].id));
assert.ok(!Model.isDescendant(home, ideas.id));

const detached = Model.detach(board.items, home.id);
assert.strictEqual(detached.title, 'Дом');
assert.ok(!Model.findItem(board.items, home.id));
ideas.children.push(detached);
assert.ok(Model.findItem(board.items, home.id));

const note = Model.defaultNote(10, 20);
board.items.push(note);
const found = Model.findItem(board.items, note.id);
assert.strictEqual(found.item.x, 10);
assert.strictEqual(found.parent, null);

const raw = {
  theme: 'light',
  items: [{ type: 'note', x: '8', color: 'nope', text: 'привет' }]
};
const norm = Model.normalizeState(raw);
assert.strictEqual(norm.theme, 'light');
assert.strictEqual(norm.items[0].color, 'graphite');
assert.strictEqual(norm.items[0].text, 'привет');
assert.strictEqual(norm.items[0].x, 8);

const clone = Model.cloneState(board);
clone.items[0].title = 'X';
assert.notStrictEqual(board.items[0].title, 'X');

// v1 → v2 migration
const migrated = Model.normalizeState({
  version: 1,
  theme: 'dark',
  items: [{ type: 'note', text: 'старая', x: 10, y: 20 }]
}, { primaryId: '10' });
assert.strictEqual(migrated.version, 2);
assert.strictEqual(migrated.items[0].displayId, '10');
assert.strictEqual(migrated.items[0].homeDisplayId, '10');
assert.ok(migrated.layouts);

// keep existing display ids
const v2 = Model.normalizeState({
  version: 2,
  theme: 'dark',
  items: [{ type: 'note', text: 'вторая', displayId: '22', homeDisplayId: '22', x: 1, y: 1 }]
}, { primaryId: '10' });
assert.strictEqual(v2.items[0].displayId, '22');
assert.strictEqual(v2.items[0].homeDisplayId, '22');

const state = Model.normalizeState({
  version: 2,
  theme: 'dark',
  items: [
    { type: 'note', id: 'a', text: 'A', displayId: '1', homeDisplayId: '1', x: 5, y: 5 },
    { type: 'note', id: 'b', text: 'B', displayId: '2', homeDisplayId: '2', x: 15, y: 15 }
  ],
  layouts: {
    '1': { x: 0, y: 0, width: 1920, height: 1080 },
    '2': { x: 1920, y: 0, width: 1280, height: 1024 }
  }
}, { primaryId: '1' });

// disconnect monitor 2 → item B parks on primary, remembers home
Model.reconcileDisplays(state, [
  { id: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
], '1');
assert.strictEqual(state.items.find((i) => i.id === 'b').displayId, '1');
assert.strictEqual(state.items.find((i) => i.id === 'b').homeDisplayId, '2');
assert.strictEqual(state.items.find((i) => i.id === 'a').displayId, '1');
assert.strictEqual(Model.itemsForDisplay(state, '1').length, 2);
assert.strictEqual(Model.itemsForDisplay(state, '2').length, 0);

// monitor 2 comes back → B returns home
Model.reconcileDisplays(state, [
  { id: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: '2', bounds: { x: 1920, y: 0, width: 1280, height: 1024 } }
], '1');
assert.strictEqual(state.items.find((i) => i.id === 'b').displayId, '2');
assert.strictEqual(Model.itemsForDisplay(state, '2').length, 1);

// id changed but bounds match previous layout
state.items.find((i) => i.id === 'b').displayId = '2';
state.items.find((i) => i.id === 'b').homeDisplayId = '2';
Model.reconcileDisplays(state, [
  { id: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: '99', bounds: { x: 1920, y: 0, width: 1280, height: 1024 } }
], '1');
assert.strictEqual(state.items.find((i) => i.id === 'b').displayId, '99');
assert.strictEqual(state.items.find((i) => i.id === 'b').homeDisplayId, '99');

// transfer between displays
const moved = Model.transferItem(state, 'a', '99', 40, 50);
assert.ok(moved);
assert.strictEqual(moved.displayId, '99');
assert.strictEqual(moved.homeDisplayId, '99');
assert.strictEqual(moved.x, 40);
assert.strictEqual(moved.y, 50);
assert.strictEqual(Model.itemsForDisplay(state, '1').length, 0);
assert.strictEqual(Model.itemsForDisplay(state, '99').length, 2);

// setDisplayItems replaces only that display
Model.setDisplayItems(state, '1', [Model.defaultNote(1, 1, { id: 'c', text: 'C' })]);
assert.ok(Model.findItem(state.items, 'c'));
assert.ok(Model.findItem(state.items, 'a'));
assert.strictEqual(Model.itemsForDisplay(state, '1')[0].displayId, '1');

assert.ok(Model.boundsClose(
  { x: 0, y: 0, width: 100, height: 100 },
  { x: 5, y: 5, width: 100, height: 100 }
));
assert.ok(!Model.boundsClose(
  { x: 0, y: 0, width: 100, height: 100 },
  { x: 0, y: 0, width: 800, height: 600 }
));

console.log('model tests ok');
