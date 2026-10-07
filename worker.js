/**
 * Tải Sạch - tải video TikTok không watermark (Cloudflare Worker, một file).
 *
 * Lấy video theo thứ tự:
 *   1) API tikwm.com
 *   2) Đọc trực tiếp trang tiktok.com
 *   3) Nếu máy chủ thất bại, trình duyệt của người dùng tự hỏi tikwm (xử lý ở phía trang).
 */

/* ============================== Cấu hình ============================== */

const TIKTOK_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\//i;
const TIKWM = "https://www.tikwm.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/* ============================== Tiện ích ============================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const absolute = (u) => (!u ? "" : u.startsWith("http") ? u : TIKWM + (u.startsWith("/") ? "" : "/") + u);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const plain = (msg, status) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/* ============================== Nguồn lấy video ============================== */

/** Cách 1: tikwm. Tự thử lại một lần nếu bị giới hạn tốc độ. */
async function viaTikwm(url, trace) {
  const ATTEMPTS = 3;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const res = await fetch(TIKWM + "/api/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": UA,
        Accept: "application/json",
        Origin: TIKWM,
        Referer: TIKWM + "/",
      },
      body: new URLSearchParams({ url, count: "12", cursor: "0", web: "1", hd: "1" }),
    });

    let payload;
    try {
      payload = JSON.parse(await res.text());
    } catch {
      trace.push(`tikwm: HTTP ${res.status}, phản hồi không phải JSON`);
      return null;
    }

    if (payload.code === 0 && payload.data) {
      const d = payload.data;
      const src = absolute(d.hdplay || d.play);
      if (!src) {
        trace.push("tikwm: không có link video");
        return null;
      }
      return {
        id: String(d.id || Date.now()),
        src,
        title: d.title || "Video TikTok",
        author: d.author?.unique_id || "",
        thumbnail: absolute(d.cover || d.origin_cover),
        duration: d.duration || null,
        fetchHeaders: { Referer: TIKWM + "/" },
      };
    }

    if (attempt < ATTEMPTS - 1 && /limit|second/i.test(String(payload.msg || ""))) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    trace.push("tikwm: " + (payload.msg || "mã " + payload.code));
    return null;
  }
  return null;
}

/** Cách 2: đọc dữ liệu nhúng trong trang tiktok.com. */
async function viaTikTokPage(url, trace) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  const html = await res.text();
  const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    trace.push(`tiktok.com: HTTP ${res.status}, trang không chứa dữ liệu video (có thể bị chặn)`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    trace.push("tiktok.com: dữ liệu trang bị lỗi");
    return null;
  }

  const detail = data.__DEFAULT_SCOPE__?.["webapp.video-detail"];
  const item = detail?.itemInfo?.itemStruct;
  if (!item?.video) {
    trace.push(`tiktok.com: không tìm thấy video (mã ${detail?.statusCode})`);
    return null;
  }

  const v = item.video;
  const src = v.playAddr || v.bitrateInfo?.[0]?.PlayAddr?.UrlList?.[0] || "";
  if (!src) {
    trace.push("tiktok.com: không có link video");
    return null;
  }

  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return {
    id: String(item.id || Date.now()),
    src,
    title: item.desc || "Video TikTok",
    author: (typeof item.author === "object" ? item.author?.uniqueId : item.author) || "",
    thumbnail: v.cover || v.originCover || "",
    duration: v.duration || null,
    fetchHeaders: { Cookie: cookies, Referer: "https://www.tiktok.com/" },
  };
}

/** Thử lần lượt từng nguồn, trả về kết quả đầu tiên thành công. */
async function lookup(url) {
  const trace = [];
  for (const source of [viaTikwm, viaTikTokPage]) {
    try {
      const video = await source(url, trace);
      if (video) return video;
    } catch (e) {
      trace.push(`${source.name}: ${e?.message || "lỗi"}`);
    }
  }
  throw Object.assign(new Error("not found"), { trace });
}

/* ============================== API ============================== */

async function handleInfo(request) {
  const body = await request.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  if (!TIKTOK_URL.test(url)) return json({ error: "Link không hợp lệ. Hãy dán link video từ TikTok." }, 400);

  try {
    const { title, author, thumbnail, duration } = await lookup(url);
    return json({ title, author, thumbnail, duration });
  } catch (e) {
    return json({ error: "Máy chủ không lấy được video.", trace: e.trace || [] }, 422);
  }
}

async function handleDownload(searchParams) {
  const url = String(searchParams.get("url") || "").trim();
  if (!TIKTOK_URL.test(url)) return plain("Link không hợp lệ.", 400);

  try {
    const video = await lookup(url);
    const upstream = await fetch(video.src, { headers: { "User-Agent": UA, ...video.fetchHeaders } });
    if (!upstream.ok || !upstream.body) return plain(`Máy chủ video từ chối (HTTP ${upstream.status}).`, 502);

    const headers = {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="tiktok_${video.id}.mp4"`,
      "Cache-Control": "no-store",
    };
    const length = upstream.headers.get("Content-Length");
    if (length) headers["Content-Length"] = length;
    return new Response(upstream.body, { headers });
  } catch (e) {
    return plain("Không tải được video: " + (e.trace?.join(" | ") || "lỗi"), 502);
  }
}

/* ============================== Quảng cáo (Cloudflare KV) ============================== */

const ADS_KEY = "ads";
const MAX_ADS = 30;
const MAX_IMAGE = 1.5 * 1024 * 1024; // byte; ảnh đã được thu nhỏ ở trình duyệt nên thường dưới 200 KB
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const LOCAL_IMG = /^\/img\/[0-9a-f]{32}$/; // ảnh lưu trong KV, phát qua /img/<id>

const html = (body) =>
  new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

const readAds = async (env) => (env.ADS ? (await env.ADS.get(ADS_KEY, "json")) || [] : []);

const isHttps = (u) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

/** Chỉ giữ trường hợp lệ và cắt độ dài; trả về null nếu dữ liệu sai. */
function cleanAds(list) {
  if (!Array.isArray(list) || list.length > MAX_ADS) return null;
  const ads = [];
  for (const a of list) {
    const ad = {
      id: String(a.id || crypto.randomUUID()).slice(0, 40),
      title: String(a.title || "").trim().slice(0, 120),
      image: String(a.image || "").trim(),
      url: String(a.url || "").trim(),
      active: a.active !== false,
    };
    if (!ad.title || !isHttps(ad.url) || (ad.image && !isHttps(ad.image) && !LOCAL_IMG.test(ad.image))) return null;
    ads.push(ad);
  }
  return ads;
}

function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const enc = new TextEncoder();
  const given = enc.encode((request.headers.get("Authorization") || "").replace(/^Bearer /, ""));
  const secret = enc.encode(env.ADMIN_PASSWORD);
  return given.byteLength === secret.byteLength && crypto.subtle.timingSafeEqual(given, secret);
}

/** Công khai: chỉ các quảng cáo đang bật. */
async function handleAds(env) {
  return json((await readAds(env)).filter((a) => a.active));
}

/** Quản trị: GET lấy toàn bộ danh sách, PUT ghi đè danh sách mới. */
async function handleAdminAds(request, env) {
  if (!isAdmin(request, env)) return json({ error: "Sai mật khẩu." }, 401);
  if (!env.ADS) return json({ error: "Chưa gắn KV namespace tên ADS cho Worker." }, 500);
  if (request.method === "GET") return json(await readAds(env));

  const ads = cleanAds(await request.json().catch(() => null));
  if (!ads) return json({ error: "Dữ liệu không hợp lệ: cần tiêu đề, link https, tối đa " + MAX_ADS + " quảng cáo." }, 400);
  const previous = await readAds(env);
  await env.ADS.put(ADS_KEY, JSON.stringify(ads));

  // Dọn ảnh tải lên mà không quảng cáo nào còn dùng
  const used = new Set(ads.map((a) => a.image));
  const orphans = previous.filter((a) => LOCAL_IMG.test(a.image) && !used.has(a.image));
  await Promise.all(orphans.map((a) => env.ADS.delete("img:" + a.image.slice(5))));
  return json(ads);
}

/** Quản trị: nhận ảnh (đã thu nhỏ ở trình duyệt), lưu vào KV, trả về đường dẫn /img/<id>. */
async function handleUpload(request, env) {
  if (!isAdmin(request, env)) return json({ error: "Sai mật khẩu." }, 401);
  if (!env.ADS) return json({ error: "Chưa gắn KV namespace tên ADS cho Worker." }, 500);

  const type = (request.headers.get("Content-Type") || "").split(";")[0];
  if (!IMAGE_TYPES.includes(type)) return json({ error: "Chỉ nhận ảnh JPG, PNG hoặc WebP." }, 415);
  const data = await request.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_IMAGE) return json({ error: "Ảnh quá lớn (tối đa 1,5 MB)." }, 413);

  const id = crypto.randomUUID().replaceAll("-", "");
  await env.ADS.put("img:" + id, data, { metadata: { type } });
  return json({ url: "/img/" + id });
}

/** Công khai: phát ảnh đã tải lên. */
async function handleImage(pathname, env) {
  const { value, metadata } = env.ADS ? await env.ADS.getWithMetadata("img:" + pathname.slice(5), "arrayBuffer") : {};
  if (!value) return plain("Không tìm thấy ảnh.", 404);
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.type || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* ============================== Router ============================== */

export default {
  async fetch(request, env) {
    try {
      const { pathname, searchParams } = new URL(request.url);
      const { method } = request;

      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (method === "POST" && pathname === "/api/info") return await handleInfo(request);
      if (method === "GET" && pathname === "/api/download") return await handleDownload(searchParams);
      if (method === "GET" && pathname === "/api/ads") return await handleAds(env);
      if (method === "GET" && pathname === "/admin") return html(ADMIN_PAGE);
      if (method === "PUT" && pathname === "/api/admin/upload") return await handleUpload(request, env);
      if (method === "GET" && LOCAL_IMG.test(pathname)) return await handleImage(pathname, env);
      if (pathname === "/api/admin/ads" && (method === "GET" || method === "PUT")) return await handleAdminAds(request, env);

      return plain("Không tìm thấy trang.", 404);
    } catch {
      return plain("Lỗi máy chủ.", 500);
    }
  },
};

/* ============================== Giao diện ============================== */

const ICON = {
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

const STYLE = String.raw`
:root {
  --bg: #0b1020; --bg-2: #121936; --surface: rgba(255,255,255,.055); --surface-2: rgba(255,255,255,.09);
  --line: rgba(255,255,255,.12); --text: #eef1fb; --muted: #9aa5c4;
  --accent: #ff4f79; --accent-2: #8b5cf6; --ok: #3ddc97; --err: #ff7a95;
  --display: "Bricolage Grotesque", "Be Vietnam Pro", system-ui, sans-serif;
  --body: "Be Vietnam Pro", system-ui, -apple-system, "Segoe UI", sans-serif;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; font: 16px/1.6 var(--body); color: var(--text); background: var(--bg);
  background-image:
    radial-gradient(60rem 32rem at 85% -10%, rgba(139,92,246,.28), transparent 60%),
    radial-gradient(48rem 28rem at -10% 8%, rgba(255,79,121,.20), transparent 60%);
  background-repeat: no-repeat;
}
.wrap { max-width: 760px; margin: 0 auto; padding: 0 20px; }
a { color: inherit; }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; border-radius: 8px; }
[hidden] { display: none !important; }

/* Đầu trang */
.top { display: flex; align-items: center; justify-content: space-between; padding: 20px 0; }
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; font: 800 1.3rem var(--display); letter-spacing: -.02em; }
.nav a { padding: 8px 12px; color: var(--muted); text-decoration: none; font-size: .95rem; border-radius: 8px; }
.nav a:hover { color: var(--text); background: var(--surface); }

/* Hero */
.hero { padding: 36px 0 56px; text-align: center; }
h1 { margin: 0 auto; max-width: 14ch; font: 800 clamp(2.4rem, 9vw, 4.2rem)/1.03 var(--display); letter-spacing: -.035em; text-wrap: balance; }
.lead { margin: 18px auto 0; max-width: 44ch; color: var(--muted); font-size: 1.05rem; }

/* Biểu mẫu */
.form {
  margin-top: 32px; padding: 10px; text-align: left; border-radius: 24px;
  background: var(--surface); border: 1px solid var(--line);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 24px 60px -24px rgba(0,0,0,.6);
}
.form:focus-within { border-color: rgba(255,255,255,.3); }
.row { display: flex; align-items: center; gap: 4px; padding: 0 2px 0 10px; border-radius: 14px; }
.row + .row { border-top: 1px solid var(--line); border-radius: 0; }
.row.bad { background: rgba(255,79,121,.14); }
.row input { flex: 1; min-width: 0; height: 52px; padding: 0 6px; border: 0; background: none; outline: none; font-size: 16px; }
.row input::placeholder { color: #6f7ba0; }
.ib { flex: none; width: 44px; height: 44px; display: grid; place-items: center; border: 0; border-radius: 12px; background: none; color: var(--muted); cursor: pointer; }
.ib:hover { background: var(--surface-2); color: var(--text); }
.actions { display: grid; gap: 8px; margin-top: 8px; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px; height: 52px; padding: 0 26px;
  border: 1px solid transparent; border-radius: 14px; font-weight: 600; text-decoration: none; cursor: pointer;
}
.btn.primary { color: #fff; background: linear-gradient(135deg, var(--accent), #e23a8f 55%, var(--accent-2)); box-shadow: 0 10px 28px -10px rgba(255,79,121,.7); }
.btn.primary:hover { filter: brightness(1.08); }
.btn.ghost { background: var(--surface); border-color: var(--line); }
.btn.ghost:hover { background: var(--surface-2); }
.btn.sm { height: 40px; padding: 0 16px; font-size: .92rem; border-radius: 10px; }
.btn.add { height: 44px; padding: 0 18px; font-size: .95rem; }
.btn.add span { color: var(--muted); font-weight: 500; }
.btn:disabled { opacity: .55; cursor: not-allowed; }

.spin { width: 16px; height: 16px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.3); border-top-color: #fff; animation: rot .7s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }

.status { min-height: 1.6em; margin: 14px 4px 0; font-size: .95rem; color: var(--muted); }
.status.err { color: var(--err); }
.status.ok { color: var(--ok); font-weight: 500; }

.perks { list-style: none; margin: 26px 0 0; padding: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 22px; color: var(--muted); font-size: .92rem; }
.perks li { display: flex; align-items: center; gap: 8px; }
.perks svg { color: var(--ok); }

/* Kết quả */
.results { margin-top: 28px; text-align: left; }
.res-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.res-count { margin: 0; font-weight: 600; }
.res-tools { display: flex; align-items: center; gap: 14px; }
.link { padding: 6px 0; border: 0; background: none; color: var(--muted); text-decoration: underline; cursor: pointer; font-size: .9rem; }
.link:hover { color: var(--text); }
.list { display: grid; gap: 12px; }

.item { display: grid; grid-template-columns: 92px 1fr; gap: 14px; padding: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 20px; }
.clip { position: relative; aspect-ratio: 9 / 16; overflow: hidden; border-radius: 14px; background: var(--bg-2); }
.clip img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .35s; }
.clip.ready img { opacity: 1; }
.i-body { min-width: 0; }
.i-author { margin: 0; color: var(--muted); font-size: .88rem; font-weight: 500; word-break: break-word; }
.i-title { margin: 2px 0 0; font-size: .98rem; font-weight: 600; line-height: 1.4; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.chip { display: inline-block; margin-top: 8px; padding: 1px 10px; background: var(--surface-2); border-radius: 999px; font-size: .78rem; color: var(--muted); }
.i-status { display: flex; align-items: center; gap: 8px; margin: 8px 0 0; font-size: .88rem; color: var(--muted); }
.i-status:empty, .i-title:empty, .i-author:empty, .i-trace:empty { display: none; }
.i-status[data-tone="ok"] { color: var(--ok); }
.i-status[data-tone="err"], .item[data-state="error"] .i-status { color: var(--err); }
.i-trace { margin: 4px 0 0; font-size: .74rem; color: var(--muted); word-break: break-word; }
.i-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.item:not([data-state="ready"]) .dl, .item:not([data-state="ready"]) .open, .item:not([data-state="error"]) .retry { display: none; }

/* Hiệu ứng watermark bị quét sạch: khoảnh khắc nổi bật duy nhất của trang */
.wm { position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: none; clip-path: inset(0); transition: clip-path .9s cubic-bezier(.7,0,.2,1) .5s; }
.wm-lines { position: absolute; inset: -35%; display: grid; align-content: center; gap: 10px; transform: rotate(-24deg); font: 800 .6rem var(--display); color: #8e9bc4; white-space: nowrap; user-select: none; }
.wm-lines span:nth-child(even) { margin-left: 24px; }
.clip.ready .wm { clip-path: inset(0 0 0 100%); }
.clip.ready .wm-lines { color: rgba(255,255,255,.8); text-shadow: 0 1px 6px rgba(0,0,0,.5); }
.edge { position: absolute; top: 0; bottom: 0; left: 0; width: 3px; z-index: 2; opacity: 0; background: var(--accent); box-shadow: 0 0 16px 2px var(--accent); pointer-events: none; }
.clip.ready .edge { animation: sweep .9s cubic-bezier(.7,0,.2,1) .5s both; }
@keyframes sweep { 0% { left: 0; opacity: 1; } 92% { opacity: 1; } 100% { left: 100%; opacity: 0; } }

/* Quảng cáo: một thẻ, hai vị trí (hàng cuộn ngang dưới kết quả, lưới ở giữa trang) */
.tag { margin-left: 8px; padding: 2px 10px; font: 500 .75rem var(--body); letter-spacing: 0; color: var(--muted); background: var(--surface-2); border-radius: 999px; vertical-align: middle; }
.ads { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.ads.row { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 6px; scrollbar-width: thin; }
.ads.row .ad { flex: 0 0 150px; scroll-snap-align: start; }
.ad { display: flex; flex-direction: column; overflow: hidden; text-decoration: none; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; transition: transform .15s, background .15s; }
.ad:hover { background: var(--surface-2); transform: translateY(-2px); }
.ad img, .ad .ph { width: 100%; aspect-ratio: 1; object-fit: cover; background: var(--bg-2); }
.ad span { padding: 10px 12px 0; font-size: .9rem; font-weight: 500; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ad small { padding: 4px 12px 12px; color: var(--accent); font-size: .82rem; font-weight: 600; }
.promo { margin-top: 18px; padding: 14px; background: var(--surface); border: 1px dashed var(--line); border-radius: 20px; }
.promo-label { margin: 0 0 10px; color: var(--muted); font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; }

/* Các mục bên dưới */
.block { padding: 56px 0; border-top: 1px solid var(--line); }
.block h2 { margin: 0 0 24px; font: 800 clamp(1.5rem, 5vw, 2rem)/1.15 var(--display); letter-spacing: -.025em; }
.steps { display: grid; gap: 14px; margin: 0; padding: 0; list-style: none; }
.steps li { display: grid; grid-template-columns: 48px 1fr; align-items: start; padding: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; }
.num { font: 800 1.9rem/1 var(--display); color: var(--accent); }
.steps h3 { margin: 0 0 2px; font-size: 1.02rem; }
.steps p { margin: 0; color: var(--muted); }
details { border-top: 1px solid var(--line); }
details:last-child { border-bottom: 1px solid var(--line); }
summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 0; font-weight: 600; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary svg { flex: none; color: var(--muted); transition: transform .2s; }
details[open] summary svg { transform: rotate(45deg); }
details p { margin: 0 0 18px; max-width: 60ch; color: var(--muted); }
footer { padding: 28px 0 44px; border-top: 1px solid var(--line); color: var(--muted); font-size: .88rem; text-align: center; }
footer p { margin: 0 0 6px; }
footer strong { color: var(--text); font: 800 1rem var(--display); }

@media (min-width: 600px) { .actions { grid-template-columns: auto 1fr; } .item { grid-template-columns: 108px 1fr; } }
@media (min-width: 900px) { .steps { grid-template-columns: repeat(3, 1fr); } .steps li { grid-template-columns: 1fr; gap: 12px; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
`;

const BODY = `
<div class="wrap">
  <header class="top">
    <a class="brand" href="/" aria-label="Tải Sạch - trang chủ">
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4f79"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
        <rect width="32" height="32" rx="9" fill="url(#g)"/>
        <path d="M16 8v11m0 0-5-5m5 5 5-5M9 24h14" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
      <span>Tải Sạch</span>
    </a>
    <nav class="nav" aria-label="Điều hướng"><a href="#cach-dung">Cách dùng</a><a href="#hoi-dap">Hỏi đáp</a></nav>
  </header>

  <main>
    <section class="hero">
      <h1>Tải video TikTok không watermark</h1>
      <p class="lead">Dán link, nhận file MP4 sạch logo ở chất lượng cao nhất. Miễn phí, không cần đăng ký.</p>

      <div class="form">
        <div id="rows"></div>
        <div class="actions">
          <button id="add" class="btn ghost add" type="button">Thêm link <span id="count">1/5</span></button>
          <button id="go" class="btn primary" type="button"><span id="spin" class="spin" hidden></span><span id="goLabel">Lấy video</span></button>
        </div>
      </div>
      <div id="status" class="status" role="status" aria-live="polite"></div>

      <div id="results" class="results" hidden>
        <div class="res-head">
          <p id="resCount" class="res-count"></p>
          <div class="res-tools">
            <button id="dlAll" class="btn primary sm" type="button" hidden>Tải tất cả</button>
            <button id="clearAll" class="link" type="button">Xóa tất cả</button>
          </div>
        </div>
        <div id="list" class="list"></div>
        <aside id="adsResult" class="promo" hidden aria-label="Quảng cáo">
          <p class="promo-label">Quảng cáo</p>
          <div id="adRow" class="ads row"></div>
        </aside>
      </div>

      <ul class="perks">
        <li>${ICON.check}Không logo, không tên người đăng</li>
        <li>${ICON.check}Tối đa 5 video cùng lúc</li>
        <li>${ICON.check}Không cần cài ứng dụng</li>
      </ul>
    </section>

    <section id="ads" class="block" hidden aria-labelledby="h-ads">
      <h2 id="h-ads">Gợi ý cho bạn<span class="tag">Quảng cáo</span></h2>
      <div id="adList" class="ads"></div>
    </section>

    <section id="cach-dung" class="block" aria-labelledby="h-cach-dung">
      <h2 id="h-cach-dung">Cách dùng</h2>
      <ol class="steps">
        <li><span class="num" aria-hidden="true">1</span><div><h3>Sao chép link</h3><p>Mở video trong TikTok, bấm Chia sẻ rồi chọn Sao chép liên kết.</p></div></li>
        <li><span class="num" aria-hidden="true">2</span><div><h3>Dán và lấy video</h3><p>Dán link vào ô phía trên, cần nhiều video thì bấm Thêm link.</p></div></li>
        <li><span class="num" aria-hidden="true">3</span><div><h3>Tải về máy</h3><p>Bấm Tải video hoặc Tải tất cả. File MP4 nằm trong mục Tải xuống.</p></div></li>
      </ol>
    </section>

    <section id="hoi-dap" class="block" aria-labelledby="h-hoi-dap">
      <h2 id="h-hoi-dap">Câu hỏi thường gặp</h2>
      <details><summary>Dùng có mất phí không?${ICON.plus}</summary><p>Không. Công cụ miễn phí và không yêu cầu đăng ký tài khoản.</p></details>
      <details><summary>Tải nhiều video cùng lúc được không?${ICON.plus}</summary><p>Được, tối đa 5 link mỗi lần. Bạn có thể dán một lần nhiều link để trang tự chia vào các ô. Khi bấm Tải tất cả, hãy chọn Cho phép nếu trình duyệt hỏi quyền tải nhiều file.</p></details>
      <details><summary>Video được lưu ở đâu?${ICON.plus}</summary><p>Thường là mục Tải xuống của trình duyệt. Trên iPhone, mở ứng dụng Tệp rồi vào thư mục Tải xuống.</p></details>
      <details><summary>Vì sao đôi khi không tải được?${ICON.plus}</summary><p>Video có thể đã bị xóa, ở chế độ riêng tư, hoặc là bài đăng ảnh. Nếu dịch vụ quá tải, hãy bấm Thử lại sau vài giây.</p></details>
      <details><summary>Tôi có được đăng lại video không?${ICON.plus}</summary><p>Chỉ nên tải video của chính bạn hoặc video bạn được phép dùng. Hãy xin phép và ghi nguồn khi đăng lại.</p></details>
    </section>
  </main>

  <footer>
    <p><strong>Tải Sạch</strong></p>
    <p>Công cụ độc lập, không liên kết với TikTok. Máy chủ không lưu video, file được chuyển thẳng tới thiết bị.</p>
  </footer>
</div>
`;

// Lưu ý: script phía trình duyệt không dùng dấu backtick hay ${...} vì nằm trong String.raw.
const SCRIPT = String.raw`
const MAX = 5;
const START_GAP = 400; // ms giữa hai video bắt đầu lấy
const IN_APP = /TaiSachApp/.test(navigator.userAgent); // đang chạy trong ứng dụng Android
const TIKTOK = /^https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\//i;
const LINK_RE = /https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\/[^\s]+/gi;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rowsEl = $("rows"), addBtn = $("add"), countEl = $("count");
const goBtn = $("go"), goLabel = $("goLabel"), spin = $("spin"), statusEl = $("status");
const results = $("results"), listEl = $("list"), resCount = $("resCount"), dlAll = $("dlAll"), clearAll = $("clearAll");

let busy = false, dlBusy = false, hasAds = false, items = [];

const SVG_PASTE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg>';
const SVG_CLOSE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/* ---------- Tiện ích ---------- */
function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  (children || []).forEach((c) => node.append(c));
  return node;
}
const button = (cls, text, onClick) => el("button", { type: "button", className: cls, textContent: text, onclick: onClick });
const fmt = (s) => Math.floor(Math.round(s) / 60) + ":" + String(Math.round(s) % 60).padStart(2, "0");
const abs = (u) => (!u ? "" : u.indexOf("http") === 0 ? u : "https://www.tikwm.com" + (u[0] === "/" ? "" : "/") + u);

function say(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

/* ---------- Các ô nhập ---------- */
const inputOf = (row) => row.querySelector("input");

function iconButton(cls, svg, label, onClick) {
  const b = el("button", { type: "button", className: "ib " + cls, innerHTML: svg, title: label, onclick: onClick });
  b.setAttribute("aria-label", label);
  return b;
}

function makeRow(value) {
  const row = el("div", { className: "row" });
  const input = el("input", { type: "url", value: value || "", spellcheck: false });
  input.setAttribute("inputmode", "url");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-label", "Link video TikTok");
  input.addEventListener("input", () => { row.classList.remove("bad"); spreadLinks(row); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  row.append(
    input,
    iconButton("paste", SVG_PASTE, "Dán link từ bộ nhớ tạm", () => pasteInto(row)),
    iconButton("rm", SVG_CLOSE, "Xóa ô này", () => { row.remove(); refreshRows(); })
  );
  return row;
}

function addRow(value, after) {
  if (rowsEl.children.length >= MAX) return null;
  const row = makeRow(value);
  if (after) after.after(row); else rowsEl.append(row);
  refreshRows();
  return row;
}

function refreshRows() {
  const rows = Array.from(rowsEl.children);
  countEl.textContent = rows.length + "/" + MAX;
  addBtn.disabled = busy || rows.length >= MAX;
  rows.forEach((row, i) => {
    row.querySelector(".rm").hidden = rows.length === 1;
    inputOf(row).placeholder = rows.length === 1 ? "Dán link video TikTok vào đây" : "Link video " + (i + 1);
  });
}

// Dán nhiều link một lúc thì tự chia vào các ô; dán cả đoạn chia sẻ thì chỉ giữ link.
function spreadLinks(row) {
  const input = inputOf(row);
  const links = Array.from(new Set(input.value.match(LINK_RE) || []));
  if (links.length > 1) {
    input.value = links[0];
    let last = row, dropped = 0;
    links.slice(1).forEach((l) => { const r = addRow(l, last); if (r) last = r; else dropped++; });
    say(dropped ? "Chỉ nhận tối đa " + MAX + " link mỗi lần, link thừa đã bị bỏ qua." : "Đã tách thành " + links.length + " link. Bấm Lấy video để tiếp tục.", dropped ? "err" : "");
  } else if (links.length === 1 && /\s/.test(input.value.trim())) {
    input.value = links[0];
  }
}

async function pasteInto(row) {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return say("Bộ nhớ tạm đang trống. Hãy sao chép link video TikTok trước.", "err");
    say("");
    inputOf(row).value = text;
    row.classList.remove("bad");
    spreadLinks(row);
  } catch (e) {
    say("Trình duyệt không cho đọc bộ nhớ tạm. Hãy nhấn giữ vào ô và chọn Dán.", "err");
    inputOf(row).focus();
  }
}

function collect() {
  const urls = new Set();
  let bad = 0;
  Array.from(rowsEl.children).forEach((row) => {
    const v = inputOf(row).value.trim();
    row.classList.remove("bad");
    if (!v) return;
    if (TIKTOK.test(v)) urls.add(v); else { row.classList.add("bad"); bad++; }
  });
  return { urls: Array.from(urls), bad: bad };
}

function setBusy(b, label) {
  busy = b;
  goBtn.disabled = b;
  spin.hidden = !b;
  goLabel.textContent = label || "Lấy video";
  clearAll.disabled = b;
  refreshRows();
}

/* ---------- Lấy thông tin video ---------- */
// Cách 1: nhờ máy chủ Cloudflare
async function viaWorker(url) {
  const res = await fetch("/api/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Máy chủ báo lỗi " + res.status), { trace: data.trace || [], userMessage: data.error });
  return Object.assign(data, { kind: "worker" });
}

// Cách 2: trình duyệt tự hỏi tikwm (dùng IP của người dùng nên ít bị chặn hơn)
async function viaBrowser(url) {
  const res = await fetch("https://www.tikwm.com/api/", { method: "POST", body: new URLSearchParams({ url: url, hd: "1" }) });
  const j = await res.json();
  if (j.code !== 0 || !j.data) throw new Error(j.msg || "tikwm không trả về video");
  const d = j.data, src = abs(d.hdplay || d.play);
  if (!src) throw new Error("không có link video");
  return { kind: "browser", src: src, id: String(d.id || Date.now()), title: d.title || "Video TikTok", author: (d.author && d.author.unique_id) || "", thumbnail: abs(d.cover || d.origin_cover), duration: d.duration || null };
}

/* ---------- Thẻ kết quả ---------- */
function createItem(url) {
  const lines = el("div", { className: "wm-lines" });
  for (let i = 0; i < 7; i++) lines.append(el("span", { textContent: "@tên_người_dùng" }));

  const img = el("img", { alt: "" });
  img.referrerPolicy = "no-referrer";
  const clip = el("div", { className: "clip" }, [img, el("div", { className: "wm" }, [lines]), el("div", { className: "edge" })]);

  const it = { url: url, state: "loading", info: null, clip: clip, img: img };
  it.author = el("p", { className: "i-author" });
  it.title = el("h3", { className: "i-title" });
  it.chip = el("span", { className: "chip", hidden: true });
  it.statusEl = el("p", { className: "i-status" });
  it.trace = el("p", { className: "i-trace" });
  it.openLink = el("a", { className: "btn ghost sm open", target: "_blank", rel: "noopener noreferrer", textContent: "Mở ở tab mới", hidden: true });
  it.dlBtn = button("btn primary sm dl", "Tải video", () => saveItem(it, false));
  it.retryBtn = button("btn ghost sm retry", "Thử lại", () => retryItem(it));

  const actions = el("div", { className: "i-actions" }, [it.dlBtn, it.openLink, it.retryBtn]);
  const body = el("div", { className: "i-body" }, [it.author, it.title, it.chip, it.statusEl, it.trace, actions]);
  it.el = el("article", { className: "item" }, [clip, body]);
  it.el.dataset.state = "loading";
  return it;
}

function setState(it, state, msg, tone) {
  it.state = state;
  it.el.dataset.state = state;
  it.statusEl.textContent = "";
  if (state === "loading") it.statusEl.append(el("span", { className: "spin" }));
  if (msg) it.statusEl.append(document.createTextNode(msg));
  if (tone) it.statusEl.dataset.tone = tone; else delete it.statusEl.dataset.tone;
}

function updateHead() {
  const ready = items.filter((i) => i.state === "ready").length;
  resCount.textContent = items.length + " video" + (ready < items.length ? " (sẵn sàng " + ready + ")" : "");
  dlAll.hidden = ready < 2;
  if (!dlBusy) dlAll.textContent = "Tải tất cả (" + ready + ")";
}

function fill(it, info) {
  it.info = info;
  it.author.textContent = info.author ? "@" + info.author : "";
  it.title.textContent = info.title || "Video TikTok";
  it.chip.hidden = !info.duration;
  if (info.duration) it.chip.textContent = fmt(info.duration);
  it.img.alt = "Ảnh xem trước video";
  it.img.src = info.thumbnail || "";
  it.openLink.hidden = info.kind !== "browser";
  if (info.kind === "browser") it.openLink.href = info.src;
  it.trace.textContent = "";
  setState(it, "ready", "");
  void it.el.offsetWidth; // để hiệu ứng quét watermark luôn chạy
  it.clip.classList.add("ready");
  updateHead();
}

function fail(it, msg, trace) {
  setState(it, "error", msg);
  it.trace.textContent = trace && trace.length ? "Chi tiết: " + trace.join(" | ") : "";
  updateHead();
}

async function loadItem(it) {
  it.clip.classList.remove("ready");
  it.trace.textContent = "";
  setState(it, "loading", "Đang lấy video...");
  updateHead();

  let info, notes = [];
  try {
    info = await viaWorker(it.url);
  } catch (e) {
    if (e.userMessage && /không hợp lệ/i.test(e.userMessage)) return fail(it, e.userMessage, []);
    notes = e.trace && e.trace.length ? e.trace.slice() : [e.message];
    try {
      info = await viaBrowser(it.url);
    } catch (e2) {
      return fail(it, "Không lấy được video. Video có thể đã xóa, ở chế độ riêng tư, hoặc cả hai cách đều bị chặn.", notes.concat("trình duyệt: " + (e2.message || "lỗi")));
    }
  }
  fill(it, info);
}

async function retryItem(it) {
  if (busy) return;
  it.retryBtn.disabled = true;
  await loadItem(it);
  it.retryBtn.disabled = false;
}

function resetResults() {
  items = [];
  listEl.textContent = "";
  results.hidden = true;
  $("adsResult").hidden = true;
}

async function run() {
  if (busy) return;
  const c = collect();
  if (c.bad) return say("Có " + c.bad + " link không hợp lệ (ô tô đỏ). Hãy dán link video từ TikTok.", "err");
  if (!c.urls.length) {
    say("Hãy dán link video TikTok vào ô phía trên.", "err");
    return inputOf(rowsEl.firstElementChild).focus();
  }

  say("");
  resetResults();
  items = c.urls.map(createItem);
  items.forEach((it) => listEl.append(it.el));
  results.hidden = false;
  updateHead();
  results.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Chạy song song. Mỗi video xuất phát lệch nhau một nhịp ngắn vì tikwm giới hạn tốc độ.
  let done = 0;
  const label = () => (items.length > 1 ? "Đang lấy video " + done + "/" + items.length : "Đang lấy video");
  setBusy(true, label());
  await Promise.all(
    items.map(async (it, i) => {
      await sleep(i * START_GAP);
      await loadItem(it);
      done++;
      goLabel.textContent = label();
    })
  );
  setBusy(false);

  const ok = items.filter((i) => i.state === "ready").length;
  $("adsResult").hidden = !(ok && hasAds);
  if (ok === items.length) say(ok > 1 ? "Đã sẵn sàng " + ok + " video." : "Video đã sẵn sàng.", "ok");
  else say("Sẵn sàng " + ok + "/" + items.length + " video. Với video lỗi, bấm Thử lại.", ok ? "" : "err");
}

/* ---------- Tải về ---------- */
async function saveItem(it, quiet) {
  const info = it.info;
  if (!info) return false;
  const src = info.kind === "worker" ? "/api/download?url=" + encodeURIComponent(it.url) : info.src;
  if (IN_APP) { // WebView: giao cho DownloadManager của Android xử lý
    el("a", { href: src, download: "" }).click();
    setState(it, "ready", "Đang tải về, xem thông báo của Android.", "ok");
    return true;
  }
  it.dlBtn.disabled = true;
  setState(it, "ready", "Đang tải video...");
  try {
    const r = await fetch(src);
    if (!r.ok) throw new Error((await r.text()) || "lỗi " + r.status);
    const a = el("a", { href: URL.createObjectURL(await r.blob()), download: "tiktok_" + info.id + ".mp4" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    setState(it, "ready", "Đã bắt đầu tải về. Xem trong mục Tải xuống.", "ok");
    return true;
  } catch (e) {
    if (info.kind === "browser" && !quiet) {
      window.open(info.src, "_blank", "noopener");
      setState(it, "ready", "Video đã mở ở tab mới. Nhấn giữ vào video rồi chọn Tải xuống.", "err");
    } else {
      setState(it, "ready", "Tải không thành công: " + (e.message || "lỗi không rõ").slice(0, 100), "err");
    }
    return false;
  } finally {
    it.dlBtn.disabled = false;
  }
}

async function downloadAll() {
  if (dlBusy) return;
  const ready = items.filter((i) => i.state === "ready");
  if (!ready.length) return;
  dlBusy = true;
  dlAll.disabled = true;
  dlAll.textContent = "Đang tải " + ready.length + " video";
  // Tải đồng thời; lệch nhau 200 ms để trình duyệt không bỏ sót file nào.
  const results = await Promise.all(ready.map(async (it, i) => { await sleep(i * 200); return saveItem(it, true); }));
  const ok = results.filter(Boolean).length;
  dlBusy = false;
  dlAll.disabled = false;
  updateHead();
  const failed = ready.length - ok;
  say(failed ? "Đã tải " + ok + "/" + ready.length + " video. Với " + failed + " video còn lại, hãy bấm Tải video ở từng video." : "Đã bắt đầu tải " + ok + " video. Nếu trình duyệt hỏi, hãy chọn Cho phép tải nhiều file.", failed ? "err" : "ok");
}

function resetAll() {
  if (busy) return;
  resetResults();
  rowsEl.textContent = "";
  addRow("");
  say("");
  inputOf(rowsEl.firstElementChild).focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Quảng cáo ---------- */
// Hai vị trí: (1) dưới kết quả, hiện khi video đã sẵn sàng, lúc người dùng đang chú ý; (2) mục giữa trang, không chắn form.
function adCard(ad) {
  const a = el("a", { className: "ad", href: ad.url, target: "_blank", rel: "sponsored nofollow noopener noreferrer" });
  a.append(ad.image ? el("img", { src: ad.image, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }) : el("div", { className: "ph" }));
  a.append(el("span", { textContent: ad.title }), el("small", { textContent: "Xem ngay" }));
  return a;
}

async function loadAds() {
  try {
    const pool = await (await fetch("/api/ads")).json();
    if (!Array.isArray(pool) || !pool.length) return;
    const mixed = pool.slice().sort(() => Math.random() - 0.5);
    const rest = mixed.length > 4 ? mixed.slice(4, 10) : mixed; // ít quảng cáo thì dùng lại cho đủ chỗ
    mixed.slice(0, 4).forEach((ad) => $("adRow").append(adCard(ad)));
    rest.forEach((ad) => $("adList").append(adCard(ad)));
    $("ads").hidden = false;
    hasAds = true;
  } catch (e) {}
}

goBtn.addEventListener("click", run);
addBtn.addEventListener("click", () => { const r = addRow("", rowsEl.lastElementChild); if (r) inputOf(r).focus(); });
dlAll.addEventListener("click", downloadAll);
clearAll.addEventListener("click", resetAll);
addRow("");
loadAds();
`;

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='#ff4f79'/><path d='M16 8v11m0 0-5-5m5 5 5-5M9 24h14' stroke='white' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'/></svg>"
  );

const PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tải Sạch - Tải video TikTok không watermark</title>
<meta name="description" content="Dán link, nhận file MP4 không logo TikTok ở chất lượng cao nhất. Tải tối đa 5 video cùng lúc, miễn phí, không cần đăng ký.">
<meta name="theme-color" content="#0b1020">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Be+Vietnam+Pro:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>`;

/* ============================== Trang quản trị ============================== */

const ADMIN_SCRIPT = String.raw`
const $ = (s) => document.querySelector(s);
const LOCAL = /^\/img\/[0-9a-f]{32}$/;
const HINT_UP = "Chọn ảnh từ máy hoặc kéo thả vào đây";
let token = sessionStorage.getItem("tk") || "", ads = [], editing = -1, pendingImage = "";

function el(tag, props, kids) {
  const node = Object.assign(document.createElement(tag), props || {});
  (kids || []).forEach((k) => node.append(k));
  return node;
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };

function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + (kind || "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = "toast"; }, 3200);
}

async function call(path, opts) {
  const o = opts || {};
  const r = await fetch(path, Object.assign({}, o, { headers: Object.assign({ Authorization: "Bearer " + token }, o.headers) }));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Lỗi " + r.status);
  return data;
}

/* ---------- Đăng nhập ---------- */
function show(loggedIn) {
  $("#login").hidden = loggedIn;
  $("#app").hidden = !loggedIn;
  $("#logout").hidden = !loggedIn;
}

async function enter() {
  try {
    ads = await call("/api/admin/ads");
    sessionStorage.setItem("tk", token);
    $("#loginErr").textContent = "";
    show(true);
    render();
  } catch (e) {
    sessionStorage.removeItem("tk");
    show(false);
    if (token) $("#loginErr").textContent = e.message;
  }
}

/* ---------- Danh sách ---------- */
async function persist(next, msg) {
  try {
    ads = await call("/api/admin/ads", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    render();
    toast(msg, "ok");
    return true;
  } catch (e) {
    toast(e.message, "err");
    return false;
  }
}

function btn(text, title, onclick, disabled, cls) {
  return el("button", { type: "button", className: "btn ghost sm " + (cls || ""), textContent: text, title: title, disabled: !!disabled, onclick: onclick });
}

function card(ad, i) {
  const swap = (d) => { const n = ads.slice(), j = i + d; [n[i], n[j]] = [n[j], n[i]]; persist(n, "Đã đổi thứ tự."); };
  const toggle = el("button", {
    type: "button", className: "switch", title: ad.active ? "Đang hiện. Bấm để ẩn" : "Đang ẩn. Bấm để hiện",
    onclick: () => persist(ads.map((a, j) => (j === i ? Object.assign({}, a, { active: !a.active }) : a)), ad.active ? "Đã ẩn quảng cáo." : "Đã bật quảng cáo."),
  });
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(ad.active));

  const thumb = ad.image ? el("img", { src: ad.image, alt: "", referrerPolicy: "no-referrer" }) : el("div", { className: "ph", textContent: "Không ảnh" });
  const meta = el("div", { className: "meta" }, [
    el("h3", { textContent: ad.title }),
    el("a", { href: ad.url, target: "_blank", rel: "noopener noreferrer", textContent: host(ad.url) }),
    el("span", { className: "badge " + (ad.active ? "on" : "off"), textContent: ad.active ? "Đang hiện" : "Đang ẩn" }),
  ]);
  const tools = el("div", { className: "tools" }, [
    btn("↑", "Đưa lên", () => swap(-1), i === 0),
    btn("↓", "Đưa xuống", () => swap(1), i === ads.length - 1),
    btn("Sửa", "Sửa quảng cáo", () => openForm(i)),
    btn("Xóa", "Xóa quảng cáo", () => confirm("Xóa quảng cáo này?") && persist(ads.filter((_, j) => j !== i), "Đã xóa quảng cáo."), false, "danger"),
  ]);
  return el("article", { className: "ad-card" + (ad.active ? "" : " dim") }, [thumb, meta, toggle, tools]);
}

function render() {
  const on = ads.filter((a) => a.active).length;
  $("#sTotal").textContent = ads.length;
  $("#sOn").textContent = on;
  $("#sOff").textContent = ads.length - on;
  const list = $("#list");
  list.textContent = "";
  ads.forEach((ad, i) => list.append(card(ad, i)));
  $("#empty").hidden = ads.length > 0;
}

/* ---------- Form thêm / sửa ---------- */
function setMode(mode) {
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("#paneUp").hidden = mode !== "up";
  $("#paneUrl").hidden = mode !== "url";
}

function preview(src) {
  const box = $("#pv");
  box.textContent = "";
  if (src) box.append(el("img", { src: src, alt: "Ảnh xem trước", referrerPolicy: "no-referrer" }));
  box.hidden = !src;
}

function openForm(i) {
  editing = i;
  const ad = i >= 0 ? ads[i] : { title: "", url: "", image: "" };
  pendingImage = ad.image || "";
  const local = LOCAL.test(pendingImage);
  $("#dlgTitle").textContent = i >= 0 ? "Sửa quảng cáo" : "Thêm quảng cáo";
  $("#fTitle").value = ad.title;
  $("#fUrl").value = ad.url;
  $("#fImage").value = local ? "" : pendingImage;
  $("#dropText").textContent = local ? "Đã có ảnh. Chọn ảnh khác để thay." : HINT_UP;
  setMode(pendingImage && !local ? "url" : "up");
  preview(pendingImage);
  $("#dlg").showModal();
}

// Thu nhỏ về tối đa 800px rồi nén JPEG: file nhẹ, tải lên nhanh, trang chủ không bị chậm.
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
  const c = el("canvas", { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("Không xử lý được ảnh."))), "image/jpeg", 0.85));
}

async function upload(file) {
  if (!file || !file.type.startsWith("image/")) return toast("Hãy chọn một file ảnh.", "err");
  $("#dropText").textContent = "Đang tải ảnh lên...";
  try {
    const r = await call("/api/admin/upload", { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: await shrink(file) });
    pendingImage = r.url;
    preview(r.url);
    $("#dropText").textContent = "Đã tải lên. Chọn ảnh khác để thay.";
  } catch (e) {
    $("#dropText").textContent = HINT_UP;
    toast(e.message, "err");
  }
}

async function submitForm() {
  const urlMode = $(".seg .on").dataset.mode === "url";
  const ad = { title: $("#fTitle").value.trim(), url: $("#fUrl").value.trim(), image: urlMode ? $("#fImage").value.trim() : pendingImage };
  if (!ad.title) return toast("Hãy nhập tiêu đề.", "err");
  if (!/^https:\/\//i.test(ad.url)) return toast("Link Shopee phải bắt đầu bằng https://", "err");
  if (ad.image && !/^https:\/\//i.test(ad.image) && !LOCAL.test(ad.image)) return toast("Link ảnh phải bắt đầu bằng https://", "err");

  const next = editing >= 0
    ? ads.map((a, j) => (j === editing ? Object.assign({}, a, ad) : a))
    : ads.concat(Object.assign({ active: true }, ad));
  if (await persist(next, editing >= 0 ? "Đã lưu thay đổi." : "Đã thêm quảng cáo.")) $("#dlg").close();
}

/* ---------- Sự kiện ---------- */
$("#loginBtn").onclick = () => { token = $("#pw").value; enter(); };
$("#pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#loginBtn").click(); });
$("#logout").onclick = () => { sessionStorage.removeItem("tk"); token = ""; $("#pw").value = ""; show(false); };
$("#addBtn").onclick = () => { if (ads.length >= 30) toast("Đã đạt tối đa 30 quảng cáo.", "err"); else openForm(-1); };
$("#cancelBtn").onclick = () => $("#dlg").close();
$("#saveBtn").onclick = submitForm;
document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("#fFile").onchange = (e) => { upload(e.target.files[0]); e.target.value = ""; };
$("#fImage").oninput = (e) => preview(/^https:\/\//i.test(e.target.value.trim()) ? e.target.value.trim() : "");
const drop = $("#drop");
["dragover", "dragenter"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((n) => drop.addEventListener(n, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => { e.preventDefault(); upload(e.dataTransfer.files[0]); });
if (token) enter();
`;

const ADMIN_PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0b1020">
<title>Quản trị quảng cáo - Tải Sạch</title>
<link rel="icon" href="${FAVICON}">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Be+Vietnam+Pro:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}
.shell { max-width: 960px; margin: 0 auto; padding: 0 20px; }
.bar { position: sticky; top: 0; z-index: 5; background: rgba(11,16,32,.82); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.bar-in { display: flex; align-items: center; justify-content: space-between; height: 62px; }
.bar-r { display: flex; align-items: center; gap: 10px; }
.bar-r a { color: var(--muted); font-size: .9rem; text-decoration: none; }
.bar-r a:hover { color: var(--text); }
.login { max-width: 400px; margin: 72px auto; padding: 28px; background: var(--surface); border: 1px solid var(--line); border-radius: 24px; }
.login h1 { margin: 0 0 6px; font: 800 1.6rem var(--display); }
.login p { margin: 0 0 18px; color: var(--muted); }
.login .btn { width: 100%; }
.err { min-height: 1.4em; margin: 0 0 10px !important; color: var(--err) !important; font-size: .9rem; }
.field { display: block; margin-bottom: 14px; font-size: .9rem; font-weight: 500; color: var(--muted); }
.field input[type=text], .field input[type=url], .field input[type=password], .field input:not([type]) { display: block; width: 100%; height: 48px; margin-top: 6px; padding: 0 14px; color: var(--text); border: 1px solid var(--line); border-radius: 12px; background: rgba(0,0,0,.25); outline: none; font-size: 16px; }
.field input:focus { border-color: var(--accent); }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 24px 0; }
.stat { padding: 16px 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; }
.stat b { display: block; font: 800 1.9rem/1.1 var(--display); }
.stat span { color: var(--muted); font-size: .85rem; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.head h2 { margin: 0; font: 800 1.3rem var(--display); }
.note { margin: 6px 0 16px; color: var(--muted); font-size: .88rem; }
.ad-list { display: grid; gap: 12px; }
.ad-card { display: grid; grid-template-columns: 72px 1fr auto; gap: 14px; align-items: center; padding: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; }
.ad-card img, .ad-card .ph { width: 72px; height: 72px; border-radius: 12px; object-fit: cover; background: var(--bg-2); }
.ad-card .ph { display: grid; place-items: center; color: var(--muted); font-size: .7rem; text-align: center; }
.ad-card.dim img, .ad-card.dim .meta h3 { opacity: .5; }
.meta { min-width: 0; display: grid; gap: 2px; justify-items: start; }
.meta h3 { margin: 0; font-size: 1rem; line-height: 1.35; word-break: break-word; }
.meta a { color: var(--muted); font-size: .82rem; text-decoration: none; }
.meta a:hover { text-decoration: underline; }
.badge { margin-top: 2px; padding: 1px 10px; border-radius: 999px; font-size: .75rem; font-weight: 600; }
.badge.on { color: var(--ok); background: rgba(61,220,151,.12); }
.badge.off { color: var(--muted); background: var(--surface-2); }
.switch { position: relative; width: 46px; height: 28px; border: 0; border-radius: 999px; background: var(--surface-2); cursor: pointer; transition: background .2s; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: transform .2s; }
.switch[aria-checked=true] { background: var(--ok); }
.switch[aria-checked=true]::after { transform: translateX(18px); }
.tools { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; padding-top: 10px; border-top: 1px solid var(--line); }
.btn.danger { color: var(--err); }
.empty { padding: 48px 20px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 20px; }
dialog { width: min(520px, calc(100vw - 24px)); max-height: calc(100vh - 24px); padding: 0; color: var(--text); background: #141a38; border: 1px solid var(--line); border-radius: 24px; }
dialog::backdrop { background: rgba(5,8,20,.72); backdrop-filter: blur(4px); }
.dlg { padding: 22px; }
.dlg h2 { margin: 0 0 18px; font: 800 1.3rem var(--display); }
.seg { display: flex; gap: 4px; margin: 6px 0 10px; padding: 4px; background: rgba(0,0,0,.25); border-radius: 12px; }
.seg button { flex: 1; height: 38px; border: 0; border-radius: 9px; background: none; color: var(--muted); font-weight: 600; cursor: pointer; }
.seg button.on { background: var(--surface-2); color: var(--text); }
.drop { display: grid; place-items: center; min-height: 92px; padding: 14px; text-align: center; color: var(--muted); border: 1.5px dashed var(--line); border-radius: 14px; cursor: pointer; }
.drop:hover, .drop.over { border-color: var(--accent); color: var(--text); }
.pv { margin-top: 12px; }
.pv img { display: block; width: 120px; height: 120px; object-fit: cover; border-radius: 14px; border: 1px solid var(--line); }
.dlg-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.toast { position: fixed; left: 50%; bottom: 24px; z-index: 20; padding: 12px 18px; max-width: calc(100vw - 32px); border-radius: 14px; background: #1d2447; border: 1px solid var(--line); opacity: 0; transform: translate(-50%, 12px); pointer-events: none; transition: .25s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.ok { border-color: var(--ok); }
.toast.err { border-color: var(--err); }
@media (min-width: 720px) {
  .ad-card { grid-template-columns: 72px 1fr auto auto; }
  .tools { grid-column: auto; padding: 0; border: 0; }
}
</style>
</head>
<body>
<header class="bar"><div class="shell bar-in">
  <a class="brand" href="/admin">Tải Sạch<span class="tag">Quản trị</span></a>
  <div class="bar-r"><a href="/" target="_blank" rel="noopener">Xem trang chủ</a><button id="logout" class="btn ghost sm" type="button" hidden>Đăng xuất</button></div>
</div></header>

<main class="shell">
  <section id="login" class="login">
    <h1>Đăng nhập</h1>
    <p>Nhập mật khẩu quản trị để quản lý quảng cáo.</p>
    <label class="field">Mật khẩu<input id="pw" type="password" autocomplete="current-password"></label>
    <p id="loginErr" class="err" role="alert"></p>
    <button id="loginBtn" class="btn primary" type="button">Đăng nhập</button>
  </section>

  <section id="app" hidden>
    <div class="stats">
      <div class="stat"><b id="sTotal">0</b><span>Tổng số</span></div>
      <div class="stat"><b id="sOn">0</b><span>Đang hiện</span></div>
      <div class="stat"><b id="sOff">0</b><span>Đang ẩn</span></div>
    </div>
    <div class="head"><h2>Quảng cáo</h2><button id="addBtn" class="btn primary sm" type="button">+ Thêm quảng cáo</button></div>
    <p class="note">Trang chủ hiển thị ngẫu nhiên các quảng cáo đang hiện, ở hai vị trí: dưới kết quả tải và mục "Gợi ý cho bạn". Thay đổi có hiệu lực ngay.</p>
    <div id="list" class="ad-list"></div>
    <div id="empty" class="empty" hidden>Chưa có quảng cáo nào. Bấm "Thêm quảng cáo" để bắt đầu.</div>
  </section>
</main>

<dialog id="dlg" aria-labelledby="dlgTitle"><div class="dlg">
  <h2 id="dlgTitle"></h2>
  <label class="field">Tiêu đề<input id="fTitle" type="text" maxlength="120" placeholder="Ví dụ: Giá đỡ điện thoại giảm 30%"></label>
  <label class="field">Link Shopee affiliate<input id="fUrl" type="url" inputmode="url" placeholder="https://s.shopee.vn/..."></label>
  <div class="field">Ảnh (không bắt buộc)
    <div class="seg"><button type="button" data-mode="up" class="on">Tải từ máy</button><button type="button" data-mode="url">Dán link</button></div>
    <div id="paneUp"><label id="drop" class="drop"><input id="fFile" type="file" accept="image/*" hidden><span id="dropText"></span></label></div>
    <div id="paneUrl" hidden><input id="fImage" type="url" inputmode="url" placeholder="https://..."></div>
    <div id="pv" class="pv" hidden></div>
  </div>
  <div class="dlg-actions"><button id="cancelBtn" class="btn ghost sm" type="button">Hủy</button><button id="saveBtn" class="btn primary sm" type="button">Lưu</button></div>
</div></dialog>

<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>${ADMIN_SCRIPT}</script>
</body>
</html>`;
