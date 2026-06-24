// @ts-nocheck
// 网络拦截层（数据层过滤，主路径）：hook fetch / XHR，被动过滤 B 站自身请求的 JSON 列表，
// 把命中本地规则的项从数组删掉，让页面只渲染保留项。只读不发——不重发请求、不需 WBI、不触发风控。
// 注：本层是 fetch/XHR 描述符级别的猴补丁，天然 any 偏多，暂保留 @ts-nocheck（渐进类型化）。
import { CONFIG } from './config';
import { log } from './logging';
import { normFeedItem } from './cardinfo';
import { matchRule } from './match/engine';
import { recordBlock } from './stats';

// 接口注册：re=URL 匹配，get=从 data 里取出可过滤的数组（就地 splice 即生效）。
const FEED_HOOKS = [
  { re: /\/x\/web-interface\/wbi\/index\/top\/feed\/rcmd/, get: (d) => (d && Array.isArray(d.item) ? d.item : null) },
  { re: /\/x\/web-interface\/index\/top\/feed\/rcmd/, get: (d) => (d && Array.isArray(d.item) ? d.item : null) },
  { re: /\/x\/web-interface\/ranking\/v2/, get: (d) => (d && Array.isArray(d.list) ? d.list : null) },
  { re: /\/x\/web-interface\/popular(\/|\?|$)/, get: (d) => (d && Array.isArray(d.list) ? d.list : null) },
  { re: /\/x\/web-interface\/archive\/related/, get: (d) => (Array.isArray(d) ? d : null) },
  // 搜索页：type=视频 时 data.result 直接是视频数组；综合(all/v2) 时 data.result 是分组，取 result_type==='video' 的 data
  {
    re: /\/x\/web-interface\/wbi\/search\/(type|all\/v2)/,
    get: (d) => {
      if (!d || !Array.isArray(d.result)) return null;
      if (d.result.length && d.result[0] && d.result[0].result_type) {
        const g = d.result.find((x) => x.result_type === 'video');
        return g && Array.isArray(g.data) ? g.data : null;
      }
      return d.result;
    },
  },
];
export const isFeedUrl = (url) => !!url && FEED_HOOKS.some((h) => h.re.test(url));

// 就地过滤一个已解析的 JSON 响应：命中项从 json.data 的数组里原地 splice 删除。
// 返回删除条数（0 表示未改动），调用方据此决定是否需要重建响应/重序列化。
function filterFeedJson(url, json) {
  // 审查模式下不在数据层删项，让视频照常渲染，交给 DOM 层标记，便于核对
  if (!CONFIG.enabled || CONFIG.reviewMode || !json || json.code !== 0 || !json.data) return 0;
  const hook = FEED_HOOKS.find((h) => h.re.test(url));
  if (!hook) return 0;
  const arr = hook.get(json.data);
  if (!arr || !arr.length) return 0;
  let removed = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    try {
      const info = normFeedItem(arr[i]);
      if (!info) continue; // 白名单由 matchRule 内部短路，无需在此重复判断
      const reason = matchRule(info);
      if (reason) {
        recordBlock(reason, info, 'NET');
        arr.splice(i, 1);
        removed++;
      }
    } catch (e) {
      // 逐项容错：单条畸形 item 抛错只跳过该项，不让整条响应放弃过滤（B站偶发异形数据时尤其重要）
    }
  }
  if (removed) log(`拦截层 删除 ${removed} 项 @ ${url.split('?')[0]}`);
  return removed;
}

// 可插拔网络管线（以「JSON 原地过滤」为中心，fetch 与 XHR 共用一套）。
//   preFn:  (url) => newUrl|void   —— 渲染前改写请求 URL（仅处理字符串 URL）
//   postFn: (url, json) => removedCount —— 原地修改解析后的 JSON，返回删除条数
const NET = (() => {
  const preFns = [];
  const postFns = [];
  return {
    addPre: (fn) => preFns.push(fn),
    addPost: (fn) => postFns.push(fn),
    hasPre: () => preFns.length > 0,
    rewriteUrl(url) {
      let u = url;
      for (const fn of preFns) {
        try {
          const r = fn(u);
          if (typeof r === 'string' && r) u = r;
        } catch (e) {}
      }
      return u;
    },
    runJson(url, json) {
      let removed = 0;
      for (const fn of postFns) {
        try {
          removed += fn(url, json) || 0;
        } catch (e) {}
      }
      return removed;
    },
  };
})();

// 注册唯一的内容过滤 postFn（即 filterFeedJson）；以后新增过滤器只需再 addPost 一条。
NET.addPost(filterFeedJson);
// 注册「增大首页推荐请求数」preFn（默认关，opt-in）：拦截层会删项，调大 ps 可让信息流删后仍饱满。
NET.addPre((url) => {
  if (!CONFIG.boostFeedLoad) return;
  if (/\/x\/web-interface\/(wbi\/)?index\/top\/feed\/rcmd/.test(url) && /[?&]ps=\d+/.test(url)) {
    return url.replace(/([?&]ps=)\d+/, '$1' + 30);
  }
});

// 过滤文本响应：无删项时原样返回 raw（省一次序列化、且保持字节一致）。
function computeFilteredText(url, raw) {
  try {
    const json = JSON.parse(raw);
    return NET.runJson(url, json) ? JSON.stringify(json) : raw;
  } catch (e) {
    return raw;
  }
}

export function installNetworkHooks() {
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // —— fetch ——
  const RespCtor = W.Response || Response;
  if (typeof W.fetch === 'function' && !W.fetch.__bfb) {
    const origFetch = W.fetch;
    const wrapped = function (input, init) {
      // 请求改写（preFn）：仅当输入是字符串 URL 时处理，避免重建 Request 对象的副作用
      let input2 = input;
      if (NET.hasPre() && typeof input === 'string') input2 = NET.rewriteUrl(input);
      const url = typeof input2 === 'string' ? input2 : (input2 && input2.url) || '';
      const p = origFetch.call(this, input2, init);
      if (!isFeedUrl(url)) return p;
      return p.then((resp) =>
        resp
          .clone()
          .json()
          .then((json) => {
            // 无命中删项：原样返回真实响应，保留 url/type/redirected 等元信息，且不重序列化
            if (!NET.runJson(url, json)) return resp;
            // 有删项才重建响应：剔除 content-encoding/length（正文已是明文 JSON，旧头会误导消费者）
            const h = new Headers(resp.headers);
            h.delete('content-encoding');
            h.delete('content-length');
            return new RespCtor(JSON.stringify(json), { status: resp.status, statusText: resp.statusText, headers: h });
          })
          .catch(() => resp)
      );
    };
    wrapped.__bfb = true;
    try {
      W.fetch = wrapped;
    } catch (e) {}
  }

  // —— XMLHttpRequest —— 在 open 时给目标请求实例装上惰性 getter，
  // 读取时（readyState 4）才解析+过滤，规避页面处理器先于我们读取的时序问题。
  const XHR = W.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__bfb) {
    const origOpen = XHR.prototype.open;
    const dText = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
    const dResp = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');
    XHR.prototype.open = function (method, url) {
      const self = this;
      // 请求改写（preFn）：仅处理字符串 URL
      const url2 = NET.hasPre() && typeof url === 'string' ? NET.rewriteUrl(url) : url;
      if (isFeedUrl(url2)) {
        // 同一次响应只过滤一次：responseText 与 response(text 型) 共用这份文本 memo，
        // 避免消费者同时读两者时过滤跑两遍、导致计数与屏蔽记录翻倍。
        const filteredText = (getRaw) => {
          if (self.__bfbText === undefined) self.__bfbText = computeFilteredText(url2, getRaw());
          return self.__bfbText;
        };
        if (dText && dText.get) {
          Object.defineProperty(self, 'responseText', {
            configurable: true,
            get() {
              if (self.readyState !== 4) return dText.get.call(self);
              return filteredText(() => dText.get.call(self));
            },
          });
        }
        if (dResp && dResp.get) {
          Object.defineProperty(self, 'response', {
            configurable: true,
            get() {
              if (self.readyState !== 4) return dResp.get.call(self);
              const rt = self.responseType;
              // json 型只能读 .response（读 responseText 会抛错），单独 memo 一份对象
              if (rt === 'json') {
                if (self.__bfbResp === undefined) {
                  const orig = dResp.get.call(self);
                  try {
                    if (orig && typeof orig === 'object') NET.runJson(url2, orig); // 原地删项
                    self.__bfbResp = orig;
                  } catch (e) {
                    self.__bfbResp = orig;
                  }
                }
                return self.__bfbResp;
              }
              // text/'' 型：与 responseText 共用同一份文本 memo
              if (rt === '' || rt === 'text') {
                const orig = dResp.get.call(self);
                return typeof orig === 'string' ? filteredText(() => orig) : orig;
              }
              return dResp.get.call(self);
            },
          });
        }
      }
      // 用改写后的 url2 调原始 open（保留 async/user/password 透传）
      return origOpen.call(this, method, url2, arguments.length > 2 ? arguments[2] : true, arguments[3], arguments[4]);
    };
    XHR.prototype.__bfb = true;
  }
}
