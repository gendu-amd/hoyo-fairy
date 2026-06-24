// 接口层：缓存 + 小并发限速队列 + 风控熔断。API 取数与批量拉黑共用。
import { RISK_CODES } from './constants';
import { CONFIG, scheduleSave, setUidName } from './config';
import { capMapSet } from './util';
import { logErr } from './logging';
import { toast } from './ui/toast';

// 缓存容量上限（防长会话内存无界）：view/card 对象较大用 800，tag 较小用 1200。
const VIEW_CACHE_MAX = 800;
const TAG_CACHE_MAX = 1200;
const CARD_CACHE_MAX = 800;

// 风控熔断：B 站返回风控码时全局暂停联网并指数退避，保护账号。
export const riskGuard = {
  until: 0,
  strikes: 0,
  blocked(): boolean {
    return Date.now() < this.until;
  },
  remaining(): number {
    return Math.max(0, this.until - Date.now());
  },
  // 任何联网响应都喂进来：风控码→升级退避；正常码→冷却期过后清零。
  note(code: number | null | undefined): void {
    if (code == null || !RISK_CODES.has(code)) {
      if (code === 0 && this.strikes && !this.blocked()) this.strikes = 0;
      return;
    }
    const wasBlocked = this.blocked();
    this.strikes = Math.min(this.strikes + 1, 6);
    const backoff = Math.min(60000, 2000 * 2 ** (this.strikes - 1)); // 2s→4s→…→封顶 60s
    this.until = Date.now() + backoff;
    if (!wasBlocked) {
      logErr('风控熔断', `code ${code}，暂停联网 ${Math.round(backoff / 1000)}s`);
      toast(`⚠️ 触发 B 站风控(code ${code})，已暂停联网 ${Math.round(backoff / 1000)} 秒以保护账号`, 'error');
    }
  },
};

type ApiCb = (data: any) => void;

// 小并发 + 较短冷却：兼顾速度与风控。每个请求完成后冷却 DELAY 再释放并发位。
const API = {
  view: new Map<string, any>(),
  tag: new Map<string, any>(),
  card: new Map<string, any>(),
  queue: [] as Array<(done: () => void) => void>,
  active: 0,
  waiting: false,
  CONCURRENCY: 3,
  DELAY: 120,
};

function apiPump(): void {
  // 熔断中：不派发新请求，等退避窗口结束再恢复（已入队任务保持排队，不丢）
  if (riskGuard.blocked()) {
    if (!API.waiting) {
      API.waiting = true;
      setTimeout(() => {
        API.waiting = false;
        apiPump();
      }, riskGuard.remaining() + 50);
    }
    return;
  }
  while (API.active < API.CONCURRENCY && API.queue.length) {
    const task = API.queue.shift()!;
    API.active++;
    task(() => {
      setTimeout(() => {
        API.active--;
        apiPump();
      }, API.DELAY);
    });
  }
}

function apiEnqueue(task: (done: () => void) => void): void {
  API.queue.push(task);
  apiPump();
}

function gmGet(url: string, cb: ApiCb): void {
  if (typeof GM_xmlhttpRequest !== 'function') {
    cb(null);
    return;
  }
  // withCredentials 不在 @types/tampermonkey 的 Request 类型里，但运行期 TM 接受（携带 Cookie）；
  // 为保持与 v0.0.5 完全一致，保留该字段并对详情对象做一次宽松断言。
  GM_xmlhttpRequest({
    method: 'GET',
    url,
    withCredentials: true,
    timeout: 12000,
    onload: (r: { responseText: string }) => {
      try {
        const j = JSON.parse(r.responseText);
        riskGuard.note(j && j.code); // 风控码喂给熔断器
        cb(j);
      } catch (e) {
        cb(null);
      }
    },
    onerror: () => cb(null),
    ontimeout: () => cb(null),
  } as any);
}

export function fetchView(bvid: string, cb: ApiCb): void {
  if (!bvid) return cb(null);
  if (API.view.has(bvid)) return cb(API.view.get(bvid));
  apiEnqueue((done) => {
    gmGet('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), (j) => {
      const d = j && j.code === 0 ? j.data : null;
      capMapSet(API.view, bvid, d, VIEW_CACHE_MAX); // d.owner.mid 即可反查 uid，无需另设缓存
      if (d && d.owner && d.owner.mid && d.owner.name && CONFIG.uidNames[String(d.owner.mid)] === undefined) {
        setUidName(d.owner.mid, d.owner.name); // 持久化（软上限内）：面板按名展示
        scheduleSave();
      }
      cb(d);
      done();
    });
  });
}

export function fetchTags(bvid: string, cb: ApiCb): void {
  if (!bvid) return cb(null);
  if (API.tag.has(bvid)) return cb(API.tag.get(bvid));
  apiEnqueue((done) => {
    gmGet('https://api.bilibili.com/x/web-interface/view/detail/tag?bvid=' + encodeURIComponent(bvid), (j) => {
      const arr = j && j.code === 0 && Array.isArray(j.data) ? j.data.map((x: any) => x.tag_name).filter(Boolean) : null;
      capMapSet(API.tag, bvid, arr, TAG_CACHE_MAX);
      cb(arr);
      done();
    });
  });
}

export function fetchCard(mid: string, cb: ApiCb): void {
  if (!mid) return cb(null);
  if (API.card.has(mid)) return cb(API.card.get(mid));
  apiEnqueue((done) => {
    gmGet('https://api.bilibili.com/x/web-interface/card?mid=' + encodeURIComponent(mid), (j) => {
      const d = j && j.code === 0 ? j.data : null;
      capMapSet(API.card, mid, d, CARD_CACHE_MAX);
      cb(d);
      done();
    });
  });
}

// 从 view 缓存里同步取 uid（已请求过的 bvid 才有；否则返回空串）。
export function cachedUid(bvid: string): string {
  const d = bvid && API.view.get(bvid);
  return d && d.owner && d.owner.mid ? String(d.owner.mid) : '';
}
