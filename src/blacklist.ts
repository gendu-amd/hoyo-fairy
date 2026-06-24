// @ts-nocheck
// 一键拉黑：调官方 relation/modify (act=5) 写入账号黑名单，刷新后不再被推荐（未登录则仅本地屏蔽）。
// 复用接口层的 view 缓存/限速队列与风控熔断；支持联合投稿连带拉黑与顺序批量拉黑。
// 注：GM POST 详情与多态回调暂以 any 处理，保留 @ts-nocheck（渐进类型化）。
import { fetchView, riskGuard } from './api';
import { getCookie } from './util';
import { CONFIG, saveConfig, setUidName } from './config';
import { addToList, pushUnique, removeFromList } from './rules';
import { emitRulesChanged } from './events';
import { toast } from './ui/toast';
import { extractCardInfo } from './cardinfo';
import { logBlocked } from './stats';
import { log } from './logging';

// 用 BV 号反查 UP 的 uid/name（页面取不到 UID 时的兜底，走视频详情接口）。复用接口层 view 缓存。
function resolveUidByBvid(bvid, cb) {
  fetchView(bvid, (d) => {
    if (d && d.owner) cb(String(d.owner.mid), d.owner.name || '');
    else cb('', '');
  });
}

// relation/modify 常见错误码 → 友好文案。
export const REL_ERR = {
  '-101': '未登录或登录已过期',
  '-111': 'CSRF 校验失败，请刷新页面重试',
  '-352': '触发 B 站风控，请稍后再试',
  22120: '该用户已在你的黑名单中',
};

// 真正调接口拉黑（已确定 uid）。quiet=true 时不弹单条提示（批量/联合投稿场景由调用方汇总）。
function doBlacklist(uid, upName, cb, quiet) {
  const label = upName || uid;
  const addLocal = () => {
    if (upName) setUidName(uid, upName);
    // 批量(quiet) 不逐条存盘/重扫——由 doBlacklistMany.finish 统一一次 saveConfig+重扫，避免 N 次全页重扫卡顿。
    if (quiet) pushUnique(CONFIG.block.uids, [String(uid)]);
    else addToList(CONFIG.block.uids, String(uid));
  };
  const csrf = getCookie('bili_jct');
  if (!csrf) {
    addLocal();
    if (!quiet) toast(`未登录，已本地屏蔽「${label}」(未同步账号黑名单)`, 'warn');
    cb && cb(false, -101);
    return;
  }
  GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.bilibili.com/x/relation/modify',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // gaia_source=web_main 贴合当前官方 web 端行为，降低被风控/失败概率
    data: `fid=${encodeURIComponent(uid)}&act=5&re_src=11&gaia_source=web_main&csrf=${encodeURIComponent(csrf)}`,
    withCredentials: true,
    onload: (res) => {
      let code = null;
      let msg = '';
      try {
        const j = JSON.parse(res.responseText);
        code = j.code;
        msg = j.message || '';
      } catch (e) {}
      riskGuard.note(code); // 拉黑响应也喂给熔断器（批量拉黑触发风控时全局退避）
      addLocal();
      // 22120 = 已在黑名单，视作成功（幂等）
      const ok = code === 0 || code === 22120;
      // 成功拉黑写入屏蔽记录（单发/批量共用），让用户能看到“这次拉黑了谁”
      if (ok) logBlocked('拉黑', { up: upName || (CONFIG.uidNames && CONFIG.uidNames[String(uid)]) || '', uid: String(uid) }, 'BL');
      if (!quiet) {
        // 仅对「本次新拉黑(code 0)」提供撤销：22120 是此前就已在黑名单，撤销它可能误删用户早先的设置，故不提供。
        if (code === 0) toast(`已拉黑并同步账号黑名单：${label}（刷新后不再推荐）`, 'success', { label: '撤销', onClick: () => unblockUp(String(uid), upName) });
        else if (code === 22120) toast(`「${label}」此前已在账号黑名单，已本地同步`, 'success');
        else toast(`账号侧拉黑失败（${REL_ERR[code] || msg || 'code ' + code}），已本地屏蔽：${label}`, 'warn');
      }
      cb && cb(ok, code);
    },
    onerror: () => {
      addLocal();
      if (!quiet) toast(`网络错误，已本地屏蔽：${label}`, 'error');
      cb && cb(false, null);
    },
  });
}

// 撤销拉黑（relation/modify act=6 取消拉黑）：账号侧移出黑名单 + 本地移出 block.uids（刷新后该 UP 恢复推荐）。
// 给「不可逆账号写操作」一个可恢复路径：单条拉黑成功后的撤销 toast、面板屏蔽记录的撤销按钮共用。
export function unblockUp(uid, upName, cb) {
  const label = upName || uid;
  const csrf = getCookie('bili_jct');
  if (!csrf) {
    removeFromList(CONFIG.block.uids, String(uid)); // 未登录：仅能撤销本地屏蔽
    toast(`已移出本地屏蔽：${label}（未登录，账号黑名单未变动）`, 'warn');
    cb && cb(false, -101);
    return;
  }
  GM_xmlhttpRequest({
    method: 'POST',
    url: 'https://api.bilibili.com/x/relation/modify',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `fid=${encodeURIComponent(uid)}&act=6&re_src=11&gaia_source=web_main&csrf=${encodeURIComponent(csrf)}`,
    withCredentials: true,
    onload: (res) => {
      let code = null;
      let msg = '';
      try {
        const j = JSON.parse(res.responseText);
        code = j.code;
        msg = j.message || '';
      } catch (e) {}
      riskGuard.note(code);
      removeFromList(CONFIG.block.uids, String(uid)); // 无论账号侧成败都移出本地屏蔽，避免界面与意图不一致
      const ok = code === 0;
      toast(ok ? `已撤销拉黑：${label}（刷新后恢复推荐）` : `账号侧撤销失败（${REL_ERR[code] || msg || 'code ' + code}），已移出本地屏蔽：${label}`, ok ? 'success' : 'warn');
      cb && cb(ok, code);
    },
    onerror: () => {
      removeFromList(CONFIG.block.uids, String(uid));
      toast(`网络错误，已移出本地屏蔽：${label}`, 'error');
      cb && cb(false, null);
    },
  });
}

// 顺序拉黑多个 UP。targets:[{uid,name}]。按真实返回码如实分类，避免把失败误报为成功。
//   cb({ added, already, failed:[{uid,code}], total })  —— 完成回调
//   onProgress({done,added,already,ok,fail,total,paused,wait}) —— 实时进度（可选）
// 限速 + 抖动：批量比单发更保守，降低被风控概率；触发风控由 riskGuard 自动指数退避并在此暂停等待。
const BL_DELAY = 900; // 每次之间基础间隔(ms)
const BL_JITTER = 700; // 叠加随机抖动(ms)，降低规律性
export function doBlacklistMany(targets, cb, onProgress) {
  const list = [];
  const seen = new Set();
  for (const t of targets) {
    const uid = String((t && t.uid) || '');
    if (uid && !seen.has(uid)) {
      seen.add(uid);
      list.push({ uid, name: (t && t.name) || '' });
    }
  }
  let added = 0; // code 0：本次新写入账号黑名单
  let already = 0; // 22120：此前已在黑名单
  let done = 0;
  let i = 0;
  const failed = []; // { uid, code }：真正没拉成的
  let cancelled = false; // 用户点「停止」
  let finished = false; // 防止「取消」与在途回调重复收尾
  let timer = null; // 当前等待中的定时器（限速/退避），取消时清掉
  const noCsrf = !getCookie('bili_jct'); // 未登录：每条都只走本地降级、不发请求，无需限速空转
  const snapshot = (paused) => ({
    done,
    added,
    already,
    ok: added + already,
    fail: failed.length,
    total: list.length,
    paused: !!paused,
    wait: paused ? Math.ceil(riskGuard.remaining() / 1000) : 0,
    cancelled,
  });
  const report = (paused) => onProgress && onProgress(snapshot(paused));
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (CONFIG.debug && failed.length) {
      const byCode = {};
      failed.forEach((f) => (byCode[f.code] = (byCode[f.code] || 0) + 1));
      log('批量拉黑失败按 code 分布：', byCode, failed);
    }
    // 批量本地屏蔽（含失败降级项）已逐条 pushUnique 进 block.uids，这里统一一次存盘 + 重扫（避免逐条 N 次重扫）。
    if (list.length) {
      saveConfig();
      emitRulesChanged();
    }
    cb && cb({ added, already, failed, total: list.length, done, cancelled });
  };
  const next = () => {
    if (cancelled || i >= list.length) return finish();
    // 熔断中：等退避窗口结束再继续，并把“暂停中 + 已完成进度”实时告知调用方（避免界面看起来无响应）
    if (riskGuard.blocked()) {
      report(true);
      timer = setTimeout(next, riskGuard.remaining() + 50);
      return;
    }
    timer = null; // 进入「在途请求」阶段：清掉已触发的旧间隔句柄，使 cancel() 必然延后到本次回调收尾（而非立即 finish）
    const t = list[i++];
    doBlacklist(
      t.uid,
      t.name,
      (s, code) => {
        done++;
        if (code === 0) added++;
        else if (code === 22120) already++;
        else failed.push({ uid: t.uid, code });
        report(false);
        if (cancelled) return finish(); // 停止：在途请求收尾后即结束，不再排下一个
        timer = setTimeout(next, noCsrf ? 0 : BL_DELAY + Math.random() * BL_JITTER);
      },
      true
    );
  };
  if (!list.length) finish();
  else next();
  // 返回控制器：cancel() 中断后续拉黑（在途请求会先正常完成；等待中则立即收尾）。
  return {
    cancel() {
      if (finished) return;
      cancelled = true;
      if (timer) finish();
    },
  };
}

// 入口：info 至少含 up；优先用 uid，没有则用 bvid 反查；都没有才退回按 UP 名本地屏蔽。
// 传 cardEl 时会先实时重抠一遍 DOM（避免用到首屏未渲染时缓存的空 uid）。
export function blacklistUp(info, cb, cardEl) {
  let uid = info && info.uid ? String(info.uid) : '';
  let upName = (info && info.up) || '';
  let bvid = (info && info.bvid) || '';
  if (cardEl) {
    const live = extractCardInfo(cardEl);
    uid = uid || live.uid;
    upName = upName || live.up;
    bvid = bvid || live.bvid;
  }
  // 联合投稿：开了开关且能拿到 BV → 读取合作者名单，主作者 + 全部合作者一并拉黑
  if (CONFIG.blacklistCollab && bvid) {
    toast('正在读取联合投稿名单…');
    fetchView(bvid, (d) => {
      const targets = [];
      if (d && d.owner) targets.push({ uid: d.owner.mid, name: d.owner.name || '' });
      if (d && Array.isArray(d.staff)) d.staff.forEach((s) => targets.push({ uid: s.mid, name: s.name || '' }));
      if (!targets.length && uid) targets.push({ uid, name: upName });
      if (!targets.length) {
        if (upName) {
          addToList(CONFIG.block.upNames, upName);
          toast(`未能解析名单，已按 UP 名本地屏蔽：${upName}`);
        } else {
          toast('该卡片信息不足，无法拉黑');
        }
        cb && cb(false);
        return;
      }
      doBlacklistMany(targets, (r) => {
        // 修正：doBlacklistMany 回调的是结果对象 {added,already,failed,total}，旧代码误按 (n,total) 取参导致文案/cb 恒错。
        const ok = r.added + r.already;
        toast(targets.length > 1 ? `联合投稿：已拉黑 ${ok}/${r.total} 位作者${r.failed.length ? `（失败 ${r.failed.length}）` : ''}` : `已拉黑：${targets[0].name || targets[0].uid}`);
        cb && cb(ok > 0);
      });
    });
    return;
  }
  if (uid) {
    doBlacklist(uid, upName, cb);
    return;
  }
  if (bvid) {
    toast('正在解析该 UP 的 UID…');
    resolveUidByBvid(bvid, (rid, rname) => {
      if (rid) {
        doBlacklist(rid, rname || upName, cb);
      } else if (upName) {
        addToList(CONFIG.block.upNames, upName);
        toast(`未能解析 UID，已按 UP 名本地屏蔽：${upName}`);
        cb && cb(false);
      } else {
        toast('未能解析该 UP，已跳过');
        cb && cb(false);
      }
    });
    return;
  }
  if (upName) {
    addToList(CONFIG.block.upNames, upName);
    toast(`该卡片没拿到 UID/BV，已按 UP 名本地屏蔽：${upName}`);
  } else {
    toast('该卡片信息不足，无法拉黑');
  }
  cb && cb(false);
}
