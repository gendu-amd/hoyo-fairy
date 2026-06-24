import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const GM_GLOBALS = {
  GM_setValue: 'readonly',
  GM_getValue: 'readonly',
  GM_addStyle: 'readonly',
  GM_xmlhttpRequest: 'readonly',
  GM_registerMenuCommand: 'readonly',
  GM_info: 'readonly',
  unsafeWindow: 'readonly',
};

export default tseslint.config(
  // 构建产物与构建脚本不参与 lint。
  { ignores: ['biliHoyoFairy.user.js', 'scripts/**', 'src/meta.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2021, ...GM_GLOBALS },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // 迁移期模块仍带 @ts-nocheck（尚未补全类型），允许之；待逐步类型化后收紧。
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': false }],
      // 关键安全网：抽离模块时若某符号"用了却忘记 import"，会成为静默全局引用 → 运行时崩。
      // no-undef 把这类漏接变成 lint 错误（@ts-nocheck 不做类型检查，故由它兜底）。
      'no-undef': 'error',
      // 迁移期遗留代码的风格性规则关掉（非正确性问题：空 catch、arguments、x&&x()、正则字符类、全角空格等），
      // 聚焦 no-undef 这一类真正会致命的漏接；待逐模块类型化后再逐步收紧。
      'no-empty': 'off',
      'no-cond-assign': 'off',
      'no-misleading-character-class': 'off',
      'no-irregular-whitespace': 'off',
      'prefer-rest-params': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
