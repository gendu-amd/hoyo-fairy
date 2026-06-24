import { beforeEach, describe, expect, it } from 'vitest';
import {
  compileLines,
  compileScopedKeywords,
  configureFuzzy,
  escapeRe,
  kwHit,
  lc,
  normMatch,
  splitRuleInput,
  stripInvisible,
  textHit,
  toHalfWidth,
} from '../src/match/normalize';

// 默认每个用例从「关闭模糊匹配」开始，避免用例间串味。
beforeEach(() => configureFuzzy(() => false));

describe('基础归一', () => {
  it('lc：去空白 + 小写；空值安全', () => {
    expect(lc('  AbC ')).toBe('abc');
    expect(lc(null)).toBe('');
    expect(lc(undefined)).toBe('');
  });
  it('toHalfWidth：全角→半角（含全角空格）', () => {
    expect(toHalfWidth('ＡＢＣ１２３')).toBe('ABC123');
    expect(toHalfWidth('原\u3000神')).toBe('原 神');
  });
  it('escapeRe：转义正则元字符', () => {
    expect(escapeRe('a.b*c')).toBe('a\\.b\\*c');
  });
  it('stripInvisible：剔除零宽/方向控制符', () => {
    expect(stripInvisible('原\u200b神\ufeff')).toBe('原神');
  });
});

describe('normMatch + fuzzy 注入', () => {
  it('fuzzy 关：保留分隔符', () => {
    configureFuzzy(() => false);
    expect(normMatch('原 神')).toBe('原 神');
  });
  it('fuzzy 开：剔除分隔符，使「原 神 / 原.神」归一为「原神」', () => {
    configureFuzzy(() => true);
    expect(normMatch('原 神')).toBe('原神');
    expect(normMatch('原.神')).toBe('原神');
    expect(normMatch('原·神')).toBe('原神');
  });
  it('始终去隐形字符 + 全角半角 + 小写', () => {
    configureFuzzy(() => false);
    expect(normMatch('Ａ\u200bB')).toBe('ab');
  });
});

describe('compileLines + textHit', () => {
  it('普通词：包含即命中（大小写/全角无关）', () => {
    const m = compileLines(['原神']);
    expect(textHit('今天玩原神', m)).toBe(true);
    expect(textHit('鸣潮', m)).toBe(false);
    expect(m.empty).toBe(false);
  });
  it('/正则/ 行：按正则命中，默认补 i 标志', () => {
    const m = compileLines(['/震惊.{0,3}你/']);
    expect(textHit('震惊！你绝对想不到', m)).toBe(true);
  });
  it('非法正则被忽略（不抛错）', () => {
    const m = compileLines(['/(/']);
    expect(m.regexes.length).toBe(0);
  });
  it('空输入 → empty 匹配器', () => {
    expect(compileLines([]).empty).toBe(true);
    expect(compileLines(null).empty).toBe(true);
  });
  it('超长 /正则/ 被忽略（ReDoS 防护）', () => {
    const huge = '/' + 'a'.repeat(2000) + '/';
    expect(compileLines([huge]).empty).toBe(true);
    // 正常长度正则仍生效
    expect(compileLines(['/abc/']).empty).toBe(false);
  });
  it('灾难性回溯形态被忽略，正常带量词正则保留', () => {
    expect(compileLines(['/(a+)+$/']).empty).toBe(true); // 嵌套量词 → 拒绝
    expect(compileLines(['/(a*)*/']).empty).toBe(true);
    expect(compileLines(['/(ab)+/']).empty).toBe(false); // 普通分组+量词 → 保留
    expect(compileLines(['/ab+/']).empty).toBe(false);
  });
  it('剥除 g/y 标志（避免 .test 复用时 lastIndex 粘连漏判）', () => {
    const re = compileLines(['/ab/g']).regexes[0];
    expect(re.flags).not.toContain('g');
    expect(re.flags).toContain('i');
    // 同一正则对象跨多次 test 仍稳定命中（无 lastIndex 推进）
    expect(re.test('xaby')).toBe(true);
    expect(re.test('xaby')).toBe(true);
    // 保留有意义的 m/s 等
    expect(compileLines(['/^a/m']).regexes[0].flags).toContain('m');
  });
  it('fuzzy 开：普通词与文本两侧一致，绕过分隔符仍命中', () => {
    configureFuzzy(() => true);
    const m = compileLines(['原神']);
    expect(textHit('原 神 启 动', m)).toBe(true);
  });
});

describe('作用域关键词 compileScopedKeywords + kwHit', () => {
  it('无前缀：对所有字段生效', () => {
    const s = compileScopedKeywords(['鬼畜']);
    expect(kwHit(s, 'title', '鬼畜区精选')).toBe(true);
    expect(kwHit(s, 'up', '鬼畜up')).toBe(true);
  });
  it('up: / part: 前缀各自限定字段', () => {
    const s = compileScopedKeywords(['up:营销号', 'part:资讯']);
    expect(kwHit(s, 'up', '某营销号')).toBe(true);
    expect(kwHit(s, 'title', '揭秘营销号')).toBe(false);
    expect(kwHit(s, 'part', '资讯')).toBe(true);
  });
  it('未知前缀按普通词进入 all', () => {
    const s = compileScopedKeywords(['tag:鬼畜']);
    expect(textHit('tag:鬼畜', s.all)).toBe(true);
    expect(s.title.empty).toBe(true);
  });
  it('title:/正则/ 前缀剥离后仍按正则编译', () => {
    const s = compileScopedKeywords(['title:/一口气.*看完/']);
    expect(kwHit(s, 'title', '一口气带你看完全集')).toBe(true);
    expect(kwHit(s, 'up', '一口气看完君')).toBe(false);
  });
});

describe('splitRuleInput：批量输入拆分（正则感知）', () => {
  it('按 逗号/中文逗号/分号/中文分号 拆分并去空白', () => {
    expect(splitRuleInput('原神, 鸣潮，崩坏;绝区零；尘白')).toEqual(['原神', '鸣潮', '崩坏', '绝区零', '尘白']);
  });
  it('换行总是分隔，空行被忽略', () => {
    expect(splitRuleInput('原神\n\n  鸣潮  \n')).toEqual(['原神', '鸣潮']);
  });
  it('以 / 开头的行整行保留，不按逗号拆断含逗号的正则', () => {
    expect(splitRuleInput('/震惊{2,3}/')).toEqual(['/震惊{2,3}/']);
    expect(splitRuleInput('/(a|b){1,2}/i')).toEqual(['/(a|b){1,2}/i']);
  });
  it('正则行与普通行混排', () => {
    expect(splitRuleInput('/a,b/\n原神,鸣潮')).toEqual(['/a,b/', '原神', '鸣潮']);
  });
  it('空白与 null/undefined → 空数组', () => {
    expect(splitRuleInput('   ')).toEqual([]);
    expect(splitRuleInput(null)).toEqual([]);
    expect(splitRuleInput(undefined)).toEqual([]);
  });
});
