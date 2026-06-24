// 样式化弹窗：替代原生 confirm()/prompt()，与面板同风格。支持键盘（Esc 取消 / Enter 确认）、点击遮罩取消、
// 危险操作默认聚焦「取消」。挂在 document.body（与 toast/panel 同级，样式由 GM_addStyle 提供，含暗色）。
interface ConfirmOpts {
  title?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}
interface PromptOpts extends ConfirmOpts {
  placeholder?: string;
  value?: string;
}

// 当前打开的弹窗（同一时刻只允许一个）。叠加打开新弹窗时，先把旧的按「取消」收掉——
// 移除其 keydown 监听并 resolve(null)，杜绝监听器泄漏与 Promise 永久悬空。
let current: { close: () => void } | null = null;

// 通用底座：统一处理遮罩/键盘/焦点/清理/叠加；fill() 负责往弹窗里塞正文+按钮并返回取值器与初始焦点。
// 结果：确定 → fill 的 value()；取消/Esc/点遮罩 → null。
function baseModal<T>(
  opts: ConfirmOpts,
  fill: (box: HTMLElement, submit: () => void, cancel: () => void) => { focus?: HTMLElement; value: () => T }
): Promise<T | null> {
  return new Promise((resolve) => {
    if (current) current.close(); // 叠加：先收掉旧弹窗（移除监听 + resolve(null)）
    const back = document.createElement('div');
    back.className = 'bfb-modal-back';
    const box = document.createElement('div');
    box.className = 'bfb-modal' + (opts.danger ? ' danger' : '');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const title = document.createElement('div');
    title.className = 'bfb-modal-title';
    title.textContent = opts.title || '确认操作';
    box.appendChild(title);

    let done = false;
    const ctl = { close: () => settle(null) };
    const settle = (v: T | null) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      if (current === ctl) current = null;
      resolve(v);
    };
    let valueGetter: () => T = () => null as unknown as T;
    const submit = () => settle(valueGetter());
    const cancel = () => settle(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    };

    const filled = fill(box, submit, cancel);
    valueGetter = filled.value;
    back.appendChild(box);
    (document.body || document.documentElement).appendChild(back);
    current = ctl;
    back.onclick = (e) => {
      if (e.target === back) cancel(); // 点遮罩（非弹窗本体）= 取消
    };
    document.addEventListener('keydown', onKey, true);
    (filled.focus || box).focus();
  });
}

function mkBtns(opts: ConfirmOpts, submit: () => void, cancel: () => void): { btns: HTMLElement; ok: HTMLElement } {
  const btns = document.createElement('div');
  btns.className = 'bfb-modal-btns';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'bfb-modal-btn ghost';
  cancelBtn.textContent = opts.cancelText || '取消';
  cancelBtn.onclick = cancel;
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'bfb-modal-btn' + (opts.danger ? ' danger' : '');
  ok.textContent = opts.okText || '确定';
  ok.onclick = submit;
  btns.append(cancelBtn, ok);
  return { btns, ok: opts.danger ? cancelBtn : ok };
}

export function confirmModal(message: string, opts: ConfirmOpts = {}): Promise<boolean> {
  return baseModal<boolean>(opts, (box, submit, cancel) => {
    const msg = document.createElement('div');
    msg.className = 'bfb-modal-msg';
    msg.textContent = message; // textContent：防注入；换行靠 CSS white-space:pre-line 呈现
    box.appendChild(msg);
    const { btns, ok } = mkBtns(opts, submit, cancel);
    box.appendChild(btns);
    return { focus: ok, value: () => true };
  }).then((v) => v === true);
}

// 样式化输入弹窗：返回输入字符串；取消/Esc/遮罩 → null。
export function promptModal(message: string, opts: PromptOpts = {}): Promise<string | null> {
  return baseModal<string>(opts, (box, submit, cancel) => {
    const msg = document.createElement('div');
    msg.className = 'bfb-modal-msg';
    msg.textContent = message;
    box.appendChild(msg);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bfb-modal-input';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value) input.value = opts.value;
    box.appendChild(input);
    const { btns } = mkBtns(opts, submit, cancel);
    box.appendChild(btns);
    return { focus: input, value: () => input.value };
  });
}
