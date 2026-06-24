// @ts-nocheck
// 通用列表字段组件：折叠头 / 添加行 / 批量管理 / chip 渲染共一套；不同字段（关键词、UP名+UID、组合标签…）
// 只需提供一个轻量 model 适配器。供设置面板复用。本层 DOM 操作密集，暂保留 @ts-nocheck（渐进类型化）。
import { CONFIG, saveConfig, setUidName } from '../config';
import { addToList, removeFromList } from '../rules';
import { splitRuleInput } from '../match/normalize';
import { fetchCard } from '../api';
import { toast } from './toast';
import { confirmModal } from './confirm';

// 记住每个字段的折叠状态（renderPanel 重建时保留）。
const collapseState = {};

export function renderListField(host, o) {
  const model = o.model;
  const el = (t, c) => {
    const e = document.createElement(t);
    if (c) e.className = c;
    return e;
  };
  const sec = el('div', 'sec field' + (o.isAllow ? ' allow' : ''));
  const lab = el('label', 'field-head');
  const collapsed = !!collapseState[o.label];
  lab.innerHTML = `<span class="caret">${collapsed ? '▸' : '▾'}</span> <span class="lt">${o.label}</span> <span class="cnt">${model.count() || ''}</span>`;
  sec.appendChild(lab);
  const body = el('div', 'field-body');
  body.style.display = collapsed ? 'none' : 'block';
  sec.appendChild(body);
  lab.onclick = () => {
    const now = body.style.display === 'none';
    body.style.display = now ? 'block' : 'none';
    collapseState[o.label] = !now;
    lab.querySelector('.caret').textContent = now ? '▾' : '▸';
  };
  const addrow = el('div', 'addrow');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = o.placeholder || '输入后点添加';
  if (o.inputTitle) input.title = o.inputTitle;
  const btn = document.createElement('button');
  btn.textContent = '添加';
  addrow.appendChild(input);
  addrow.appendChild(btn);
  body.appendChild(addrow);
  if (o.hint) {
    const h = el('div', 'hint');
    h.style.marginTop = '6px';
    h.textContent = o.hint;
    body.appendChild(h);
  }
  const bar = el('div', 'chip-bar');
  body.appendChild(bar);
  const chips = el('div', 'chips');
  body.appendChild(chips);

  let manage = false;
  const selected = new Set();
  const renderBar = () => {
    bar.innerHTML = '';
    if (!model.count()) {
      manage = false;
      return;
    }
    const mk = (text, fn, primary) => {
      const b = el('button', 'chip-act' + (primary ? ' primary' : ''));
      b.textContent = text;
      b.onclick = fn;
      bar.appendChild(b);
    };
    if (!manage) {
      mk('批量管理', () => {
        manage = true;
        selected.clear();
        renderChips();
      });
      return;
    }
    mk('全选', () => {
      model.entries().forEach((e) => selected.add(e.key));
      renderChips();
    });
    mk('反选', () => {
      model.entries().forEach((e) => (selected.has(e.key) ? selected.delete(e.key) : selected.add(e.key)));
      renderChips();
    });
    mk(`删除所选(${selected.size})`, () => {
      if (!selected.size) {
        toast('未勾选任何项');
        return;
      }
      const n = selected.size;
      const byKey = {};
      model.entries().forEach((e) => (byKey[e.key] = e));
      selected.forEach((k) => byKey[k] && removeFromList(byKey[k].arr, byKey[k].value));
      selected.clear();
      renderChips();
      toast(`已删除 ${n} 条`);
    }, true);
    mk('清空', () => {
      if (!model.count()) return;
      confirmModal(`确定清空该列表全部 ${model.count()} 条？此操作不可撤销。`, { title: '清空列表', okText: '清空', danger: true }).then((ok) => {
        if (!ok) return;
        model.clear();
        selected.clear();
        renderChips();
      });
    });
    mk('完成', () => {
      manage = false;
      selected.clear();
      renderChips();
    });
  };
  const renderChips = () => {
    chips.innerHTML = '';
    lab.querySelector('.cnt').textContent = model.count() || '';
    if (!model.count()) {
      const e = el('div', 'empty');
      e.textContent = '（暂无，添加后会显示在这里）';
      chips.appendChild(e);
      renderBar();
      return;
    }
    model.entries().forEach((entry) => {
      const chip = el('span', 'chip' + (manage && selected.has(entry.key) ? ' sel' : ''));
      const txt = document.createElement('span');
      model.decorate(entry, chip, txt, renderChips);
      chip.appendChild(txt);
      if (manage) {
        chip.style.cursor = 'pointer';
        chip.title = '点击勾选 / 取消';
        chip.onclick = () => {
          if (selected.has(entry.key)) selected.delete(entry.key);
          else selected.add(entry.key);
          renderChips();
        };
      } else {
        const x = document.createElement('b');
        x.textContent = '✕';
        x.title = '删除';
        x.onclick = () => {
          removeFromList(entry.arr, entry.value);
          renderChips();
        };
        chip.appendChild(x);
      }
      chips.appendChild(chip);
    });
    renderBar();
  };
  const doAdd = () => {
    if (model.add(input.value)) {
      input.value = '';
      renderChips();
    }
  };
  btn.onclick = doAdd;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAdd();
  });
  renderChips();
  host.appendChild(sec);
}

// 普通 chip 列表（关键词 / BV / 标签 / 白名单…）；groupMode=组合标签。
export function chipModel(arr, groupMode) {
  return {
    count: () => arr.length,
    entries: () => arr.map((v) => ({ key: v, value: v, arr })),
    clear: () => {
      arr.length = 0;
    },
    add: (raw) => {
      if (groupMode) {
        const parts = raw.split(/[+,，、\s]+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length < 2) {
          toast('组合标签至少要 2 个，如：原神 鸣潮');
          return false;
        }
        if (addToList(arr, parts.join('+'))) {
          toast(`已添加组合：${parts.join(' & ')}`);
          return true;
        }
        toast('该组合已存在');
        return false;
      }
      const parts = splitRuleInput(raw);
      if (!parts.length) return false;
      let added = 0;
      for (const v of parts) if (addToList(arr, v)) added++;
      if (added) toast(`已添加 ${added} 条${parts.length > added ? `（${parts.length - added} 条已存在）` : ''}`);
      else toast('均已存在，未重复添加');
      return true;
    },
    decorate: (entry, chip, txt) => {
      if (groupMode) chip.classList.add('group');
      txt.textContent = groupMode ? String(entry.value).split('+').join(' & ') : entry.value;
    },
  };
}

// 「UP 名 + UID」合一：纯数字→uids，否则→names；UID chip 异步解析显示名。
export function upModel(names, uids) {
  return {
    count: () => names.length + uids.length,
    entries: () =>
      names
        .map((v) => ({ key: 'n:' + v, value: v, arr: names, uid: false }))
        .concat(uids.map((v) => ({ key: 'u:' + v, value: v, arr: uids, uid: true }))),
    clear: () => {
      names.length = 0;
      uids.length = 0;
    },
    add: (raw) => {
      const parts = splitRuleInput(raw);
      if (!parts.length) return false;
      let added = 0;
      for (const v of parts) if (addToList(/^\d+$/.test(v) ? uids : names, v)) added++;
      toast(added ? `已添加 ${added} 条` : '均已存在，未重复添加');
      return true;
    },
    decorate: (entry, chip, txt, rerender) => {
      if (!entry.uid) {
        txt.textContent = entry.value;
        return;
      }
      const nm = CONFIG.uidNames[String(entry.value)];
      txt.textContent = nm || entry.value;
      chip.classList.add('uidchip');
      chip.title = 'UID ' + entry.value + (nm ? '' : '（正在解析名称…）');
      if (!nm) {
        fetchCard(entry.value, (d) => {
          const name = d && d.card && d.card.name;
          if (name) {
            setUidName(entry.value, name);
            saveConfig();
            rerender();
          }
        });
      }
    },
  };
}

// 通用控件绑定器：把「读配置 → 回填控件」与「控件变更 → 存盘 + 回调」收敛到一处。
// 支持 checkbox / select / number。obj 为目标对象（CONFIG 或 CONFIG.block）。
export function bindControl(root, id, obj, key, opts) {
  opts = opts || {};
  const el = root.querySelector('#' + id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!obj[key];
  else el.value = obj[key] != null ? obj[key] : opts.number ? 0 : '';
  el.onchange = () => {
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (opts.number) v = (opts.int ? parseInt(el.value, 10) : parseFloat(el.value)) || 0;
    else v = el.value;
    obj[key] = v;
    saveConfig();
    if (opts.after) opts.after();
  };
}

// 按描述表渲染一组「列表型」字段（黑/白名单等），新增过滤项 = 表里加一行。
export function renderFields(host, defs) {
  defs.forEach((f) => {
    if (f.kind === 'up') {
      renderListField(host, {
        label: f.label,
        hint: f.hint,
        placeholder: '输入 UP 名 或 UID（纯数字自动识别）',
        inputTitle: '可一次粘贴多条，用逗号或换行分隔；纯数字按 UID，其余按 UP 名',
        model: upModel(CONFIG.block.upNames, CONFIG.block.uids),
      });
      return;
    }
    const arr = (f.scope === 'allow' ? CONFIG.allow : CONFIG.block)[f.key];
    renderListField(host, {
      label: f.label,
      hint: f.hint,
      placeholder: f.placeholder,
      isAllow: f.scope === 'allow',
      inputTitle: f.groupMode ? '输入一组标签，用空格或逗号分隔，表示同时含这些标签才拦' : '可一次粘贴多条，用逗号或换行分隔',
      model: chipModel(arr, f.groupMode),
    });
  });
}
