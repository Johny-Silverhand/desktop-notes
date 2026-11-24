'use strict';

const api = window.sloy;
const btn = document.getElementById('toggle');
let editMode = false;
let hotkey = 'Ctrl+Alt+N';

function render() {
  if (editMode) {
    btn.classList.remove('edit');
    btn.textContent = 'На рабочий стол';
    btn.title = 'Вернуть заметки на рабочий стол (' + hotkey + ')';
  } else {
    btn.classList.add('edit');
    btn.textContent = 'Редактировать';
    btn.title = 'Открыть режим правки (' + hotkey + ')';
  }
}

btn.addEventListener('click', () => {
  if (!api) return;
  api.setEditMode(!editMode);
});

if (api) {
  if (api.onEditMode) {
    api.onEditMode((value) => {
      editMode = !!value;
      render();
    });
  }
  if (api.onMeta) {
    api.onMeta((meta) => {
      if (!meta) return;
      if (typeof meta.editMode === 'boolean') editMode = meta.editMode;
      if (meta.hotkey) hotkey = meta.hotkey;
      render();
    });
  }
  api.getEditMode().then((mode) => {
    if (!mode) return;
    editMode = !!mode.editMode;
    if (mode.hotkey) hotkey = mode.hotkey;
    render();
  }).catch(() => {});
}

render();
