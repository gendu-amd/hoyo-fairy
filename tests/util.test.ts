import { describe, expect, it } from 'vitest';
import { capMapSet, escapeHtml, parseCount, parseDuration } from '../src/util';

describe('capMapSet', () => {
  it('未超上限：正常写入', () => {
    const m = new Map<string, number>();
    capMapSet(m, 'a', 1, 3);
    capMapSet(m, 'b', 2, 3);
    expect(m.size).toBe(2);
    expect(m.get('a')).toBe(1);
  });
  it('超上限：淘汰最旧键，保留最新', () => {
    const m = new Map<string, number>();
    capMapSet(m, 'a', 1, 2);
    capMapSet(m, 'b', 2, 2);
    capMapSet(m, 'c', 3, 2); // 触发淘汰最旧的 a
    expect(m.size).toBe(2);
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
    expect(m.get('c')).toBe(3);
  });
  it('更新已存在键不增长 size', () => {
    const m = new Map<string, number>();
    capMapSet(m, 'a', 1, 2);
    capMapSet(m, 'a', 9, 2);
    expect(m.size).toBe(1);
    expect(m.get('a')).toBe(9);
  });
});

describe('parseDuration', () => {
  it('mm:ss → 秒', () => {
    expect(parseDuration('03:20')).toBe(200);
    expect(parseDuration('00:45')).toBe(45);
  });
  it('hh:mm:ss → 秒', () => {
    expect(parseDuration('1:02:03')).toBe(3723);
  });
  it('非法 / 空 → null', () => {
    expect(parseDuration('')).toBe(null);
    expect(parseDuration(null)).toBe(null);
    expect(parseDuration('abc')).toBe(null);
    expect(parseDuration('12')).toBe(null); // 无冒号不算时长
  });
});

describe('parseCount', () => {
  it('纯数字 / 含逗号空格', () => {
    expect(parseCount('1234')).toBe(1234);
    expect(parseCount('1,234')).toBe(1234);
    expect(parseCount('12 345')).toBe(12345);
  });
  it('万 / 亿 单位', () => {
    expect(parseCount('1.5万')).toBe(15000);
    expect(parseCount('2亿')).toBe(200000000);
  });
  it('非法 / 空 → null', () => {
    expect(parseCount('')).toBe(null);
    expect(parseCount(null)).toBe(null);
    expect(parseCount('abc')).toBe(null);
  });
});

describe('escapeHtml', () => {
  it('转义 & < > " \'', () => {
    expect(escapeHtml('<b>"x"&\'y\'</b>')).toBe('&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
  });
  it('空值安全', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
