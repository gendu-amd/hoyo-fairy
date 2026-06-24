import { describe, expect, it } from 'vitest';
import { parseNameList } from '../src/batch';
import { pushUnique } from '../src/rules';

describe('parseNameList：名单批量解析', () => {
  it('空格/逗号/换行/分号/顿号 混合分隔', () => {
    const r = parseNameList('123456 789012,345678\n901234;567890、112233');
    expect(r.uids).toEqual(['123456', '789012', '345678', '901234', '567890', '112233']);
    expect(r.names).toEqual([]);
  });
  it('纯数字(≥3位)按 UID；其它按 UP 名', () => {
    const r = parseNameList('原神 123456 鸣潮 99');
    expect(r.uids).toEqual(['123456']);
    expect(r.names).toEqual(['原神', '鸣潮', '99']); // 99 不足 3 位 → 当名称
  });
  it('uid: / up: 前缀（前缀与值之间不能有空格，空格是分隔符——与 v0.0.5 一致）', () => {
    const r = parseNameList('uid:123 up:某营销号 up:第二个');
    expect(r.uids).toEqual(['123']);
    expect(r.names).toEqual(['某营销号', '第二个']);
  });
  it('UID 去重，名称不去重', () => {
    const r = parseNameList('123456 123456 原神 原神');
    expect(r.uids).toEqual(['123456']);
    expect(r.names).toEqual(['原神', '原神']);
  });
  it('跳过 ! # 注释行首；空白安全', () => {
    expect(parseNameList('!comment #note 原神')).toEqual({ uids: [], names: ['原神'] });
    expect(parseNameList('   ')).toEqual({ uids: [], names: [] });
    expect(parseNameList('')).toEqual({ uids: [], names: [] });
  });
});

describe('pushUnique：纯去重追加', () => {
  it('追加新值、跳过已存在，返回新增数', () => {
    const arr = ['1', '2'];
    expect(pushUnique(arr, ['2', '3', '4', '3'])).toBe(2); // 3,4 新增；2 已在；第二个 3 也跳过
    expect(arr).toEqual(['1', '2', '3', '4']);
  });
  it('按 String 归一比较（数字与字符串等价去重）', () => {
    const arr: string[] = ['10'];
    expect(pushUnique(arr, [10 as unknown as string, '10', '20'])).toBe(1);
    expect(arr).toEqual(['10', '20']);
  });
  it('空输入返回 0、不改数组', () => {
    const arr = ['x'];
    expect(pushUnique(arr, [])).toBe(0);
    expect(arr).toEqual(['x']);
  });
});
