// @name 乌云影视
// @author nexu-agent
// @version 2.2.0
// @description 刮削：不支持，弹幕：支持，嗅探：不支持

/**
 * ============================================================================
 * 乌云影视 (wooyun.tv) - OmniBox 爬虫脚本 v2.2
 * ============================================================================
 * 已验证 API（2026-03-31）：
 *   首页：GET  /movie/media/home/custom/classify/1/3?limit=12
 *   搜索：POST /movie/media/search  body:{searchKey,pageIndex,pageSize}
 *   详情：GET  /movie/media/base/detail?mediaId={id}
 *   剧集：GET  /movie/media/video/list?mediaId={id}
 *
 * 修复记录：
 *   v2.2 - 搜索字段改为 searchKey（原 keyword 无效）
 *   v2.1 - 增加弹幕支持、片名兜底
 *   v2.0 - 基础功能
 * ============================================================================
 */

const OmniBox = require("omnibox_sdk");

// ==================== 配置 ====================
const HOST = "https://wooyun.tv";
const API = "https://wooyun.tv/movie";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DANMU_API = process.env.DANMU_API || "";

const HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json",
  "Content-Type": "application/json",
  "Referer": HOST + "/",
  "Origin": HOST
};

const CLASSES = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "tv_series", type_name: "电视剧" },
  { type_id: "short_drama", type_name: "短剧" },
  { type_id: "animation", type_name: "动画" },
  { type_id: "variety", type_name: "综艺" }
];



// ==================== 日志 ====================
const log = (level, msg) => OmniBox.log(level, `[乌云] ${msg}`);

// ==================== 请求封装 ====================
async function httpGet(path) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await OmniBox.request(url, { method: "GET", headers: HEADERS, timeout: 15000 });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

async function httpPost(path, body) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await OmniBox.request(url, {
    method: "POST", headers: HEADERS, body: JSON.stringify(body), timeout: 15000
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

// ==================== 格式化 ====================
function formatVideo(item) {
  if (!item || !item.id) return null;
  return {
    vod_id: String(item.id),
    vod_name: item.title || item.mediaName || item.originalTitle || "",
    vod_pic: item.posterUrlS3 || item.posterUrl || item.thumbnailUrl || "",
    vod_remarks: item.episodeStatus || ""
  };
}

function convertToPlaySources(seasons) {
  if (!seasons || !seasons.length) return [];
  const sources = [];
  for (const season of seasons) {
    const videos = season.videoList || [];
    if (!videos.length) continue;
    const lineName = season.seasonNo ? `第${season.seasonNo}季` : "正片";
    const episodes = videos.map(ep => ({
      name: ep.remark || `第${ep.epNo || 0}集`,
      playId: ep.playUrl || ""
    }));
    sources.push({ name: lineName, episodes });
  }
  return sources;
}

// ==================== 弹幕 ====================
function extractEpisodeNum(name) {
  if (!name) return 0;
  const cnMap = { '零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
  const m = name.match(/第\s*([零一二三四五六七八九十0-9]+)\s*[集话]/);
  if (m) { const v = cnMap[m[1]]; if (v !== undefined) return v; const n = parseInt(m[1],10); if (!isNaN(n)) return n; }
  const d = name.match(/(\d+)/);
  return d ? parseInt(d[1], 10) : 0;
}

function buildDanmuFileName(vodName, episodeName) {
  if (!vodName) return "";
  if (!episodeName || episodeName === "正片") return vodName;
  const n = extractEpisodeNum(episodeName);
  if (n > 0) return n < 10 ? `${vodName} S01E0${n}` : `${vodName} S01E${n}`;
  return vodName;
}

async function matchDanmu(fileName) {
  if (!DANMU_API || !fileName) return [];
  try {
    const res = await OmniBox.request(`${DANMU_API}/api/v2/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ fileName })
    });
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    if (!data.isMatched || !data.matches?.length) return [];
    const m = data.matches[0];
    if (!m.episodeId) return [];
    const name = m.animeTitle && m.episodeTitle ? `${m.animeTitle} - ${m.episodeTitle}` : (m.animeTitle || m.episodeTitle || "弹幕");
    log("info", `弹幕匹配成功: ${name}`);
    return [{ name, url: `${DANMU_API}/api/v2/comment/${m.episodeId}?format=xml` }];
  } catch (e) { return []; }
}

// ==================== 接口实现 ====================

async function home(params) {
  try {
    const res = await httpGet("/media/home/custom/classify/1/3?limit=12");
    const records = (res.data && res.data.records) || [];
    const list = records.flatMap(s => (s.mediaResources || []).map(formatVideo).filter(Boolean));
    return { class: CLASSES, list };
  } catch (e) {
    log("error", `首页失败: ${e.message}`);
    return { class: CLASSES, list: [] };
  }
}

async function category(params) {
  const tid = params.categoryId || params.id || "";
  const pg = parseInt(params.page) || 1;
  try {
    const res = await httpPost("/media/search", {
      pageIndex: pg,
      pageSize: 30,
      searchKey: "",
      topCode: tid
    });
    const data = res.data || {};
    const list = (data.records || []).map(formatVideo).filter(Boolean);
    return { list, page: pg, pagecount: data.pages || pg, limit: 30 };
  } catch (e) {
    return { list: [], page: pg, pagecount: pg };
  }
}

/**
 * 搜索 — 使用 searchKey 字段（v2.2.1 修复：不要传 menuCodeList 多值，会导致 0 结果）
 */
async function search(params) {
  const wd = (params.keyword || params.wd || "").trim();
  if (!wd) return { list: [] };
  try {
    const res = await httpPost("/media/search", {
      searchKey: wd,
      pageIndex: 1,
      pageSize: 50
    });
    const data = res.data || {};
    const list = (data.records || []).map(formatVideo).filter(Boolean);

    log("info", `搜索"${wd}"：找到 ${data.total || list.length} 条`);
    return { list };
  } catch (e) {
    log("error", `搜索失败: ${e.message}`);
    return { list: [] };
  }
}

async function detail(params) {
  const id = params.videoId || params.id;
  try {
    const [detailRes, videoRes] = await Promise.all([
      httpGet(`/media/base/detail?mediaId=${id}`),
      httpGet(`/media/video/list?mediaId=${id}`)
    ]);
    const info = detailRes.data || detailRes;
    const seasons = videoRes.data || [];
    const vodPlaySources = convertToPlaySources(seasons);

    return {
      list: [{
        vod_id: String(info.id),
        vod_name: info.title || info.originalTitle || "",
        vod_pic: info.posterUrlS3 || info.posterUrl || "",
        type_name: (info.mediaType || {}).name || "",
        vod_year: info.releaseYear ? String(info.releaseYear) : "",
        vod_area: info.region || "",
        vod_director: (info.directors || []).join(" "),
        vod_actor: (info.actors || []).join(" "),
        vod_content: info.overview || info.description || "",
        vod_remarks: info.episodeStatus || "",
        vod_play_from: vodPlaySources.map(s => s.name).join("$$$") || undefined,
        vod_play_sources: vodPlaySources.length > 0 ? vodPlaySources : undefined
      }]
    };
  } catch (e) {
    log("error", `详情失败: ${e.message}`);
    return { list: [] };
  }
}

async function play(params) {
  const playId = params.playId || "";
  const vodName = params.vodName || "";
  const episodeName = params.episodeName || "";
  if (!playId) return { urls: [], parse: 0, header: {} };

  const isDirect = /\.(m3u8|mp4|flv|avi|mkv|ts)/i.test(playId);
  const result = {
    urls: [{ name: "乌云专线", url: playId }],
    parse: isDirect ? 0 : 1,
    header: isDirect ? {} : { "User-Agent": UA, "Referer": HOST }
  };

  // 弹幕
  if (DANMU_API) {
    const fileName = buildDanmuFileName(vodName, episodeName);
    if (fileName) {
      const danmaku = await matchDanmu(fileName);
      if (danmaku.length > 0) result.danmaku = danmaku;
    }
  }
  return result;
}

// ==================== 导出 ====================
module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
