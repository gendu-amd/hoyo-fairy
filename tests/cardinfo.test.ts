import { describe, expect, it } from 'vitest';
import { normFeedItem } from '../src/cardinfo';

// normFeedItem 是网络拦截层（主过滤路径）把各接口 JSON 列表项归一成 CardInfo 的唯一入口，分支多、最该测。
describe('normFeedItem：拦截层 JSON 归一', () => {
  it('null / 非对象 → null', () => {
    expect(normFeedItem(null)).toBe(null);
    expect(normFeedItem(undefined)).toBe(null);
    expect(normFeedItem('x' as any)).toBe(null);
  });

  it('普通推荐项：owner / stat / title / bvid / duration', () => {
    const i = normFeedItem({ title: '标题', owner: { mid: 123, name: 'UP主' }, stat: { view: 10000, like: 500 }, bvid: 'BV1', duration: 90 })!;
    expect(i.title).toBe('标题');
    expect(i.up).toBe('UP主');
    expect(i.uid).toBe('123');
    expect(i.views).toBe(10000);
    expect(i.likes).toBe(500);
    expect(i.bvid).toBe('BV1');
    expect(i.duration).toBe(90);
    expect(i.isAd).toBe(false);
    expect(i.isLive).toBe(false);
  });

  it('广告项：goto=ad + ad_info 标题被抠出', () => {
    const i = normFeedItem({ goto: 'ad', ad_info: { creative_content: { title: '广告标题' } } })!;
    expect(i.isAd).toBe(true);
    expect(i.title).toBe('广告标题');
  });

  it('is_ad 标志也判定为广告', () => {
    expect(normFeedItem({ title: 't', is_ad: true })!.isAd).toBe(true);
  });

  it('搜索项标题中的 <em> 高亮标签被剥离', () => {
    expect(normFeedItem({ title: '玩<em class="keyword">原神</em>的人' })!.title).toBe('玩原神的人');
  });

  it('duration：number 直取 / "mm:ss" 解析 / 缺失为 null', () => {
    expect(normFeedItem({ title: 't', duration: 90 })!.duration).toBe(90);
    expect(normFeedItem({ title: 't', duration: '03:20' })!.duration).toBe(200);
    expect(normFeedItem({ title: 't' })!.duration).toBe(null);
  });

  it('views 多字段回退：stat.view → stat.play → it.play', () => {
    expect(normFeedItem({ title: 't', stat: { view: 1 } })!.views).toBe(1);
    expect(normFeedItem({ title: 't', stat: { play: 888 } })!.views).toBe(888);
    expect(normFeedItem({ title: 't', play: 777 })!.views).toBe(777);
  });

  it('uid 回退：owner.mid 优先，否则 it.mid', () => {
    expect(normFeedItem({ title: 't', mid: 456 })!.uid).toBe('456');
    expect(normFeedItem({ title: 't', owner: { mid: 1 }, mid: 2 })!.uid).toBe('1');
  });

  it('直播项：goto=live', () => {
    expect(normFeedItem({ title: 't', goto: 'live' })!.isLive).toBe(true);
  });
});
