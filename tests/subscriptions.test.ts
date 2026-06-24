import { describe, expect, it } from 'vitest';
import { parseSubscription, sanitizeSubRules } from '../src/subscriptions/parse';
import { parseExpires, cmpVer } from '../src/subscriptions/refresh';
import { saveSubStore } from '../src/subscriptions/store';
import { CONFIG, DEFAULT_CONFIG } from '../src/config';
import { matchRule, rebuildRules } from '../src/match/engine';
import type { CardInfo } from '../src/cardinfo';

const blank = (over: Partial<CardInfo> = {}): CardInfo => ({
  title: '', up: '', uid: '', partition: '', bvid: '', link: '',
  duration: null, views: null, likes: null, isLive: false, isAd: false,
  ...over,
});

describe('parseExpires / cmpVer（纯解析）', () => {
  const DAY = 24 * 3600e3;
  it('过期间隔：单位 d/h、默认 1 天、下限 1', () => {
    expect(parseExpires('2d')).toBe(2 * DAY);
    expect(parseExpires('12h')).toBe(12 * 3600e3);
    expect(parseExpires('')).toBe(DAY);
    expect(parseExpires('abc')).toBe(DAY);
    expect(parseExpires('0')).toBe(DAY); // Math.max(1, …)
  });
  it('版本逐段比较', () => {
    expect(cmpVer('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(cmpVer('0.0.6', '0.0.6')).toBe(0);
    expect(cmpVer('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });
});

describe('订阅并入：collectSubRules → buildMatchers → matchRule', () => {
  it('启用订阅的关键词能命中', () => {
    Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG));
    const url = 'https://example.com/sub.json';
    saveSubStore({ [url]: { ok: true, rules: { keywords: ['订阅词'] } } } as any);
    (CONFIG.subscriptions as any).push({ url, name: 's', enabled: true });
    rebuildRules();
    expect(matchRule(blank({ title: '含订阅词的视频' }))).toBe('关键词');
  });
  it('禁用的订阅不并入', () => {
    Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG));
    const url = 'https://example.com/sub2.json';
    saveSubStore({ [url]: { ok: true, rules: { keywords: ['禁用词'] } } } as any);
    (CONFIG.subscriptions as any).push({ url, name: 's', enabled: false });
    rebuildRules();
    expect(matchRule(blank({ title: '含禁用词' }))).toBe(null);
  });
});

describe('parseSubscription：JSON 格式', () => {
  it('读取 meta 与 rules，并对维度去重', () => {
    const { meta, rules } = parseSubscription('{"meta":{"title":"测试"},"rules":{"uids":["1","1","2"],"keywords":["原神"]}}');
    expect(meta.title).toBe('测试');
    expect(rules.uids).toEqual(['1', '2']);
    expect(rules.keywords).toEqual(['原神']);
  });
  it('兼容把导出的配置文件当订阅（从 config.block 取维度）', () => {
    const { rules } = parseSubscription('{"config":{"block":{"keywords":["a","b"]}}}');
    expect(rules.keywords).toEqual(['a', 'b']);
  });
  it('未知维度被忽略', () => {
    const { rules } = parseSubscription('{"rules":{"enabled":["x"],"uids":["1"]}}');
    expect((rules as any).enabled).toBeUndefined();
    expect(rules.uids).toEqual(['1']);
  });
});

describe('parseSubscription：uBlock 风格纯文本', () => {
  it('解析 ! 元信息、前缀维度、无前缀关键词、行内注释', () => {
    const text = ['! title: 测试', '! expires: 2d', 'uid:123', 'up: 营销号', '原神', 'kw: 鸣潮', 'bv: BV1abc', '原神 # 行内注释'].join('\n');
    const { meta, rules } = parseSubscription(text);
    expect(meta.title).toBe('测试');
    expect(meta.expires).toBe('2d');
    expect(rules.uids).toEqual(['123']);
    expect(rules.upNames).toEqual(['营销号']);
    expect(rules.bvids).toEqual(['BV1abc']);
    expect(rules.keywords).toEqual(['原神', '鸣潮']); // 行内注释剥离 + 去重
  });
  it('空内容抛错', () => {
    expect(() => parseSubscription('   ')).toThrow();
  });
});

describe('sanitizeSubRules', () => {
  it('去空去重、跳过非字符串', () => {
    expect(sanitizeSubRules({ keywords: ['a', '', '  ', 'a', 'b', 123 as any] }).keywords).toEqual(['a', 'b']);
  });
  it('正则维度上限 5000', () => {
    const many = Array.from({ length: 6000 }, (_, i) => 'k' + i);
    expect(sanitizeSubRules({ keywords: many }).keywords!.length).toBe(5000);
  });
});
