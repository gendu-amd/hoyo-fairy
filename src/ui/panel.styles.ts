// 设置面板样式：作为 import 的副作用注入（与 v0.0.5 一致——启动即注入，不等面板打开）。
  GM_addStyle(`
    .bfb-review{outline:2px solid #fb7299 !important;outline-offset:-2px;border-radius:8px;position:relative !important}
    .bfb-tag{position:absolute;top:6px;left:6px;z-index:9;display:flex;align-items:center;gap:6px;background:rgba(251,114,153,.95);color:#fff;border-radius:8px;padding:3px 6px;font-size:11px;font-family:system-ui,Arial;box-shadow:0 2px 6px rgba(0,0,0,.25)}
    .bfb-tag .rs{white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
    .bfb-tag button{border:none;border-radius:6px;background:#fff;color:#1b7a3d;font-size:11px;padding:2px 6px;cursor:pointer;white-space:nowrap}
    #bfb-badge{position:fixed;right:18px;bottom:18px;z-index:99999;background:#fb7299;color:#fff;border-radius:24px;padding:8px 14px;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.2);font-family:system-ui,Arial;user-select:none}
    #bfb-badge.off{background:#999}
    #bfb-ctxmenu{position:fixed;z-index:100002;background:#fff;border:1px solid #ffd5e2;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.22);overflow:hidden;min-width:210px;font-family:system-ui,Arial}
    .bfb-ctx-item{padding:10px 14px;font-size:13px;color:#333;cursor:pointer;white-space:nowrap}
    .bfb-ctx-item:hover{background:#fff0f5;color:#fb7299}
    #bfb-toasts{position:fixed;right:18px;bottom:70px;z-index:100001;display:flex;flex-direction:column}
    .bfb-toast{background:#fff;color:#222;border-radius:12px;padding:12px 14px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.18);max-width:320px;font-family:system-ui,Arial;border:1px solid #ffd5e2;margin-top:8px;display:flex;align-items:center;gap:10px}
    .bfb-toast .bfb-toast-msg{flex:1;min-width:0}
    .bfb-toast-act{flex:0 0 auto;border:none;border-radius:7px;background:#fb7299;color:#fff;font-size:12px;font-weight:600;padding:5px 12px;cursor:pointer}
    .bfb-toast-act:hover{background:#e85d88}
    .bfb-toast.success{border-left:4px solid #1b7a3d}
    .bfb-toast.warn{border-left:4px solid #e67e22}
    .bfb-toast.error{border-left:4px solid #e74c3c}
    .bfb-modal-back{position:fixed;inset:0;z-index:100003;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-family:system-ui,Arial;padding:16px}
    .bfb-modal{background:#fff;border-radius:14px;max-width:400px;width:88vw;box-shadow:0 12px 44px rgba(0,0,0,.32);overflow:hidden;animation:bfb-modal-in .14s ease-out}
    @keyframes bfb-modal-in{from{transform:scale(.95);opacity:.4}to{transform:scale(1);opacity:1}}
    .bfb-modal-title{padding:13px 16px;font-size:15px;font-weight:600;color:#fff;background:#fb7299}
    .bfb-modal.danger .bfb-modal-title{background:#e74c3c}
    .bfb-modal-msg{padding:14px 16px;font-size:13px;line-height:1.65;color:#333;white-space:pre-line;max-height:54vh;overflow:auto}
    .bfb-modal-btns{display:flex;gap:8px;justify-content:flex-end;padding:0 16px 14px}
    .bfb-modal-btn{border:none;border-radius:8px;padding:8px 18px;font-size:13px;cursor:pointer;background:#fb7299;color:#fff}
    .bfb-modal-btn.ghost{background:#f0f0f0;color:#444}
    .bfb-modal-btn.danger{background:#e74c3c}
    .bfb-modal-btn:focus-visible{outline:2px solid #222;outline-offset:2px}
    .bfb-modal-input{display:block;width:calc(100% - 32px);margin:0 16px 12px;padding:8px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;box-sizing:border-box;background:#fff;color:#222}
    .bfb-modal-input:focus{outline:none;border-color:#fb7299;box-shadow:0 0 0 2px rgba(251,114,153,.18)}
    #bfb-panel .bfb-sub-row{border:1px solid #eee;border-radius:8px;padding:8px;margin-top:6px;background:#fafafa}
    #bfb-panel .bfb-listta{width:100%;box-sizing:border-box;resize:vertical;font-family:monospace;font-size:12px;padding:6px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#222}
    #bfb-panel{position:fixed;top:0;right:0;width:400px;max-width:94vw;height:100vh;z-index:100000;background:#fff;box-shadow:-4px 0 24px rgba(0,0,0,.2);overflow:auto;overscroll-behavior:contain;font-family:system-ui,Arial;transform:translateX(100%);transition:transform .25s}
    #bfb-panel.open{transform:translateX(0)}
    #bfb-panel h2{margin:0;padding:14px 16px;background:#fb7299;color:#fff;font-size:16px;position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;z-index:2}
    #bfb-panel h2 .x{cursor:pointer}
    #bfb-panel .sec{padding:10px 16px;border-bottom:1px solid #f0f0f0}
    #bfb-panel .sec.allow{background:#f3fbf4}
    #bfb-panel label{font-size:13px;color:#444;display:block;margin-bottom:6px;font-weight:600}
    #bfb-panel .addrow{display:flex;gap:6px}
    #bfb-panel .addrow input{flex:1;min-width:0;padding:6px 8px;border:1px solid #ddd;border-radius:8px;font-size:13px}
    #bfb-panel .addrow button{background:#fb7299;color:#fff;border:none;border-radius:8px;padding:0 14px;cursor:pointer;font-size:13px;white-space:nowrap}
    #bfb-panel .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    #bfb-panel .chip{display:inline-flex;align-items:center;gap:6px;background:#fff0f5;color:#c2185b;border:1px solid #ffd5e2;border-radius:14px;padding:3px 10px;font-size:12px}
    #bfb-panel .sec.allow .chip{background:#eafaef;color:#1b7a3d;border-color:#c6ecd0}
    #bfb-panel .chip b{cursor:pointer;font-weight:700;opacity:.6}
    #bfb-panel .chip b:hover{opacity:1}
    #bfb-panel .empty{font-size:11px;color:#767676;margin-top:6px}
    #bfb-panel input[type=number]{width:80px;padding:4px 6px;border:1px solid #ddd;border-radius:6px}
    #bfb-panel .hint{font-size:11px;color:#6e6e6e;margin-top:4px}
    #bfb-panel .toolbar{display:flex;gap:8px;flex-wrap:wrap}
    #bfb-panel button.act{background:#fb7299;color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px}
    #bfb-panel button.ghost{background:#f3f3f3;color:#333}
    #bfb-panel .switch{display:flex;align-items:center;gap:8px;font-size:13px;color:#333;font-weight:600;margin-top:6px}
    #bfb-panel .stat{font-size:12px;color:#6e6e6e}
    #bfb-panel a.manage{color:#fb7299;font-size:12px}
    #bfb-panel .sec.api{background:#f5f3ff}
    /* —— 交互美化 —— */
    #bfb-panel h2{background:linear-gradient(135deg,#fb7299,#ff9bb6)}
    #bfb-panel .switch input[type=checkbox]{appearance:none;-webkit-appearance:none;width:38px;height:22px;border-radius:22px;background:#d4d4d8;position:relative;cursor:pointer;transition:.2s;flex:0 0 auto;margin:0}
    #bfb-panel .switch input[type=checkbox]:checked{background:#fb7299}
    #bfb-panel .switch input[type=checkbox]::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
    #bfb-panel .switch input[type=checkbox]:checked::after{transform:translateX(16px)}
    #bfb-panel .sec{transition:background .15s}
    #bfb-panel .addrow input:focus,#bfb-panel input[type=number]:focus{outline:none;border-color:#fb7299;box-shadow:0 0 0 2px rgba(251,114,153,.18)}
    /* —— 键盘焦点环（仅键盘导航时出现，鼠标点击不显示）—— */
    #bfb-panel button:focus-visible,#bfb-panel .tab:focus-visible,#bfb-panel .chip b:focus-visible,#bfb-panel .x:focus-visible,#bfb-panel a:focus-visible,#bfb-panel .switch input:focus-visible,.bfb-toast-act:focus-visible{outline:2px solid #fb7299;outline-offset:2px;border-radius:6px}
    #bfb-panel:focus{outline:none}
    #bfb-panel button.act:active,#bfb-panel .addrow button:active{transform:translateY(1px)}
    #bfb-panel::-webkit-scrollbar{width:10px}
    #bfb-panel::-webkit-scrollbar-thumb{background:#f0c2d2;border-radius:8px;border:2px solid #fff}
    #bfb-panel::-webkit-scrollbar-thumb:hover{background:#fb7299}
    #bfb-panel .chip{transition:transform .1s}
    #bfb-panel .chip:hover{transform:translateY(-1px)}
    #bfb-panel .field-head{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;margin-bottom:0;padding:4px 6px;margin-left:-6px;margin-right:-6px;border-radius:8px;transition:background .12s}
    #bfb-panel .field-head:hover{background:#fff0f5}
    #bfb-panel .field-head .caret{color:#fb7299;font-size:14px;width:14px;flex:0 0 auto;transition:transform .12s}
    #bfb-panel .chip-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    #bfb-panel .chip-act{border:1px solid #ffd5e2;background:#fff;color:#fb7299;border-radius:8px;padding:3px 10px;font-size:12px;cursor:pointer}
    #bfb-panel .chip-act:hover{background:#fff0f5}
    #bfb-panel .chip-act.primary{background:#fb7299;color:#fff;border-color:#fb7299}
    #bfb-panel .chip.sel{outline:2px solid #fb7299;outline-offset:1px;background:#ffd9e6}
    #bfb-panel .sec.allow .chip.sel{outline-color:#1b7a3d;background:#cdeed6}
    #bfb-panel .log-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,.12)}
    #bfb-panel .log-tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #bfb-panel .log-rs{color:#fb7299;margin-right:2px}
    #bfb-panel .log-link{color:inherit;text-decoration:none}
    #bfb-panel .log-link:hover{color:#fb7299;text-decoration:underline}
    #bfb-panel .log-src{flex:0 0 auto;font-size:10px;border-radius:5px;padding:0 4px;margin-right:4px;color:#fff}
    #bfb-panel .log-src.net{background:#27ae60}
    #bfb-panel .log-src.dom{background:#e67e22}
    #bfb-panel .log-blk{flex:0 0 auto;border:1px solid #ffd5e2;background:#fff;color:#fb7299;border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer}
    #bfb-panel .log-blk:hover{background:#fb7299;color:#fff}
    #bfb-panel .log-blk[disabled]{opacity:.6;cursor:default}
    #bfb-panel .log-undo{flex:0 0 auto;border:1px solid #c6ecd0;background:#fff;color:#1b7a3d;border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer}
    #bfb-panel .log-undo:hover{background:#1b7a3d;color:#fff}
    #bfb-panel .log-undo[disabled]{opacity:.6;cursor:default}
    #bfb-panel .log-pass{flex:0 0 auto;border:1px solid #c6ecd0;background:#fff;color:#1b7a3d;border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer;margin-right:6px}
    #bfb-panel .log-pass:hover{background:#1b7a3d;color:#fff}
    #bfb-panel .field-head .lt{flex:1}
    #bfb-panel .field-head .cnt{background:#fb7299;color:#fff;border-radius:10px;font-size:11px;padding:0 7px;min-width:18px;text-align:center;font-weight:700}
    #bfb-panel .field-head .cnt:empty{display:none}
    #bfb-panel .field-body{margin-top:8px}
    #bfb-panel .field .chips{max-height:132px;overflow-y:auto;overscroll-behavior:contain;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:8px;margin-top:8px}
    #bfb-panel .field .chips:empty{display:none}
    #bfb-panel .field .chips::-webkit-scrollbar{width:8px}
    #bfb-panel .field .chips::-webkit-scrollbar-thumb{background:#f0c2d2;border-radius:8px}
    #bfb-panel .field .chips::-webkit-scrollbar-thumb:hover{background:#fb7299}
    #bfb-panel .chip.uidchip::before{content:"账号";font-size:9px;background:#6b4dff;color:#fff;border-radius:5px;padding:0 4px;margin-right:2px}
    #bfb-panel .chip.group{background:#ede9fe;color:#5b21b6;border-color:#ddd6fe}
    /* —— 分组 Tab —— */
    #bfb-panel .tabs{position:sticky;top:48px;z-index:2;display:flex;flex-wrap:wrap;justify-content:center;gap:6px;padding:10px 12px;background:#fff;border-bottom:1px solid #f0f0f0;overscroll-behavior:contain}
    #bfb-panel .tab{flex:0 0 auto;padding:6px 13px;border-radius:16px;background:#f3f3f3;color:#666;font-size:13px;cursor:pointer;border:none;white-space:nowrap;font-weight:600;transition:.15s}
    #bfb-panel .tab:hover{background:#ffe3ec;color:#fb7299}
    #bfb-panel .tab.active{background:linear-gradient(135deg,#fb7299,#ff9bb6);color:#fff;box-shadow:0 2px 8px rgba(251,114,153,.35)}
    #bfb-panel .bfb-group{display:none}
    #bfb-panel .bfb-group.active{display:block;animation:bfb-fade .18s ease}
    @keyframes bfb-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    #bfb-panel .grp-tip{padding:8px 16px;font-size:11px;color:#6e6e6e;background:#fafafa;border-bottom:1px solid #f0f0f0}
    /* —— 暗色模式（跟随系统 prefers-color-scheme）：仅覆盖自有 UI 表面，品牌粉与语义色保留 —— */
    @media (prefers-color-scheme: dark){
      #bfb-panel,.bfb-toast,.bfb-modal,#bfb-ctxmenu{background:#1c1c20;color:#e6e6e9}
      #bfb-panel .sec{border-bottom-color:#2c2c32}
      #bfb-panel .sec.allow{background:rgba(39,174,96,.08)}
      #bfb-panel .sec.api{background:rgba(124,92,255,.1)}
      #bfb-panel label{color:#cfcfd6}
      #bfb-panel .switch,#bfb-panel button.ghost{color:#d0d0d6}
      #bfb-panel .hint,#bfb-panel .stat,#bfb-panel .grp-tip{color:#8a8a92}
      #bfb-panel .grp-tip{background:#232328;border-bottom-color:#2c2c32}
      #bfb-panel .bfb-sub-row{background:#232328;border-color:#34343a}
      #bfb-panel .bfb-listta{background:#26262b;color:#e6e6e9;border-color:#44444c}
      .bfb-modal-input{background:#26262b;color:#e6e6e9;border-color:#44444c}
      #bfb-panel .empty{color:#9a9aa2}
      #bfb-panel .addrow input,#bfb-panel input[type=number]{background:#26262b;border-color:#44444c;color:#e6e6e9}
      #bfb-panel button.ghost{background:#2e2e34}
      #bfb-panel .switch input[type=checkbox]{background:#45454d}
      #bfb-panel .chip{background:rgba(251,114,153,.16);color:#ff9ebc;border-color:rgba(251,114,153,.35)}
      #bfb-panel .sec.allow .chip{background:rgba(39,174,96,.16);color:#6ee7a0;border-color:rgba(39,174,96,.35)}
      #bfb-panel .chip.group{background:rgba(124,92,255,.18);color:#c4b5fd;border-color:rgba(124,92,255,.4)}
      #bfb-panel .chip.sel{background:rgba(251,114,153,.3)}
      #bfb-panel .sec.allow .chip.sel{background:rgba(39,174,96,.3)}
      #bfb-panel .field .chips{background:#232328;border-color:#34343a}
      #bfb-panel .chip-act,#bfb-panel .log-blk,#bfb-panel .log-pass,#bfb-panel .log-undo{background:#1c1c20}
      #bfb-panel .field-head:hover,#bfb-panel .chip-act:hover{background:rgba(251,114,153,.14)}
      #bfb-panel .tabs{background:#1c1c20;border-bottom-color:#2c2c32}
      #bfb-panel .tab{background:#2e2e34;color:#a8a8b0}
      #bfb-panel .tab:hover{background:rgba(251,114,153,.18)}
      #bfb-panel::-webkit-scrollbar-thumb{border-color:#1c1c20}
      .bfb-toast{border-color:#38383f}
      .bfb-modal-msg{color:#d8d8de}
      .bfb-modal-btn.ghost{background:#2e2e34;color:#d0d0d6}
      .bfb-ctx-item{color:#d8d8de}
      .bfb-ctx-item:hover{background:rgba(251,114,153,.16)}
    }
  `);
