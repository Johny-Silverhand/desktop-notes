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

console.log('model tests ok');
