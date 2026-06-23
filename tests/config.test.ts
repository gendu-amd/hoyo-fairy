import { describe, expect, it } from 'vitest';
import { deepMerge, mergeImport } from '../src/config';

describe('deepMerge', () => {
  it('递归合并同名对象，标量覆盖', () => {
    const base = { a: { x: 1, y: 2 }, b: 1 };
    deepMerge(base, { a: { y: 9, z: 3 }, b: 5 });
    expect(base).toEqual({ a: { x: 1, y: 9, z: 3 }, b: 5 });
  });
  it('数组按整体覆盖（非合并）', () => {
    const base: any = { arr: [1, 2, 3] };
    deepMerge(base, { arr: [9] });
    expect(base.arr).toEqual([9]);
  });
  it('拦截原型链污染键 __proto__', () => {
    const base: any = {};
    deepMerge(base, JSON.parse('{"__proto__":{"polluted":1}}'));
    expect(({} as any).polluted).toBeUndefined();
    expect(base.polluted).toBeUndefined();
  });
});

describe('mergeImport', () => {
  it('数组取并集去重，不丢已有', () => {
    const base: any = { block: { uids: ['1', '2'] } };
    mergeImport(base, { block: { uids: ['2', '3'] } });
    expect(base.block.uids).toEqual(['1', '2', '3']);
  });
  it('标量以导入值为准；对象递归', () => {
    const base: any = { hideAd: false, comment: { minLevel: 0 } };
    mergeImport(base, { hideAd: true, comment: { minLevel: 3 } });
    expect(base.hideAd).toBe(true);
    expect(base.comment.minLevel).toBe(3);
  });
  it('拦截原型链污染键', () => {
    const base: any = {};
    mergeImport(base, JSON.parse('{"__proto__":{"polluted":1}}'));
    expect(({} as any).polluted).toBeUndefined();
  });
});
