/**
 * Tải video TikTok không watermark - Cloudflare Worker (MỘT FILE, tự chứa cả giao diện).
 * Lấy video theo 2 cách, thử lần lượt:
 *   1) API tikwm.com
 *   2) Đọc trực tiếp trang tiktok.com
 * Nếu cả hai thất bại, trang web sẽ tự thử cách 3: trình duyệt của người dùng hỏi tikwm.
 */

const TIKTOK_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\//i;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const absolute = (u) =>
  !u ? "" : u.startsWith("http") ? u : "https://www.tikwm.com" + (u.startsWith("/") ? "" : "/") + u;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const text = (msg, status) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// ---------- Cách 1: tikwm ----------
async function viaTikwm(url, trace) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://www.tikwm.com/api/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": UA,
        Accept: "application/json",
        Origin: "https://www.tikwm.com",
        Referer: "https://www.tikwm.com/",
      },
      body: new URLSearchParams({ url: url, count: "12", cursor: "0", web: "1", hd: "1" }),
    });
    const raw = await res.text();
    let j;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      trace.push("tikwm: HTTP " + res.status + ", phản hồi không phải JSON");
      return null;
    }
    if (j.code === 0 && j.data) {
      const d = j.data;
      const src = absolute(d.hdplay || d.play);
      if (!src) {
        trace.push("tikwm: không có link video");
        return null;
      }
      return {
        id: String(d.id || Date.now()),
        src: src,
        title: d.title || "Video TikTok",
        author: (d.author && d.author.unique_id) || "",
        thumbnail: absolute(d.cover || d.origin_cover),
        duration: d.duration || null,
        fetchHeaders: { Referer: "https://www.tikwm.com/" },
      };
    }
    if (attempt === 0 && /limit|second/i.test(String(j.msg || ""))) {
      await sleep(1200);
      continue;
    }
    trace.push("tikwm: " + (j.msg || "mã " + j.code));
    return null;
  }
  return null;
}

// ---------- Cách 2: đọc trực tiếp trang tiktok.com ----------
async function viaTikTokPage(url, trace) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  const html = await res.text();
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    trace.push("tiktok.com: HTTP " + res.status + ", trang không chứa dữ liệu video (có thể bị chặn)");
    return null;
  }
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    trace.push("tiktok.com: dữ liệu trang bị lỗi");
    return null;
  }
  const scope = data["__DEFAULT_SCOPE__"] || {};
  const detail = scope["webapp.video-detail"];
  const item = detail && detail.itemInfo && detail.itemInfo.itemStruct;
  if (!item || !item.video) {
    trace.push("tiktok.com: không tìm thấy video (mã " + (detail && detail.statusCode) + ")");
    return null;
  }
  const v = item.video;
  let src = v.playAddr || "";
  if (!src && v.bitrateInfo && v.bitrateInfo[0] && v.bitrateInfo[0].PlayAddr) {
    const list = v.bitrateInfo[0].PlayAddr.UrlList;
    src = (list && list[0]) || "";
  }
  if (!src) {
    trace.push("tiktok.com: không có link video");
    return null;
  }
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .map((c) => c.split(";")[0])
    .join("; ");
  const author = typeof item.author === "object" && item.author ? item.author.uniqueId : item.author;
  return {
    id: String(item.id || Date.now()),
    src: src,
    title: item.desc || "Video TikTok",
    author: author || "",
    thumbnail: v.cover || v.originCover || "",
    duration: v.duration || null,
    fetchHeaders: { Cookie: cookies, Referer: "https://www.tiktok.com/" },
  };
}

async function lookup(url) {
  const trace = [];
  for (const tier of [viaTikwm, viaTikTokPage]) {
    try {
      const v = await tier(url, trace);
      if (v) return v;
    } catch (e) {
      trace.push(tier.name + ": " + ((e && e.message) || "lỗi"));
    }
  }
  const err = new Error("not found");
  err.trace = trace;
  throw err;
}

async function handleInfo(request) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {}
  const url = String(body.url || "").trim();
  if (!TIKTOK_URL.test(url)) {
    return json({ error: "Link không hợp lệ. Hãy dán link video từ TikTok." }, 400);
  }
  try {
    const v = await lookup(url);
    return json({
      title: v.title,
      author: v.author,
      thumbnail: v.thumbnail,
      duration: v.duration,
    });
  } catch (e) {
    return json({ error: "Máy chủ không lấy được video.", trace: e.trace || [] }, 422);
  }
}

async function handleDownload(searchParams) {
  const url = String(searchParams.get("url") || "").trim();
  if (!TIKTOK_URL.test(url)) return text("Link không hợp lệ.", 400);
  try {
    const v = await lookup(url);
    const upstream = await fetch(v.src, {
      headers: Object.assign({ "User-Agent": UA }, v.fetchHeaders),
    });
    if (!upstream.ok || !upstream.body) {
      return text("Máy chủ video từ chối (HTTP " + upstream.status + ").", 502);
    }
    const headers = {
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="tiktok_' + v.id + '.mp4"',
      "Cache-Control": "no-store",
    };
    const len = upstream.headers.get("Content-Length");
    if (len) headers["Content-Length"] = len;
    return new Response(upstream.body, { headers });
  } catch (e) {
    return text("Không tải được video: " + ((e.trace && e.trace.join(" | ")) || "lỗi"), 502);
  }
}

export default {
  async fetch(request) {
    try {
      const { pathname, searchParams } = new URL(request.url);

      if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (request.method === "POST" && pathname === "/api/info") return await handleInfo(request);
      if (request.method === "GET" && pathname === "/api/download") return await handleDownload(searchParams);

      return text("Không tìm thấy trang.", 404);
    } catch (e) {
      return text("Lỗi máy chủ.", 500);
    }
  },
};

const PAGE = "<!doctype html>\n<html lang=\"vi\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Tải Sạch - Tải video TikTok không watermark</title>\n<meta name=\"description\" content=\"Dán link, nhận file MP4 không logo TikTok ở chất lượng cao nhất. Miễn phí, không cần đăng ký, dùng được ngay trên điện thoại.\">\n<meta name=\"theme-color\" content=\"#F6F8FC\">\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23D81B47'/%3E%3Cpath d='M16 8v11m0 0-5-5m5 5 5-5M9 24h14' stroke='white' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Be+Vietnam+Pro:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n<style>\n  :root {\n    --ink: #14213d;\n    --paper: #f6f8fc;\n    --surface: #ffffff;\n    --tint: #eaeff8;\n    --line: #dce3ef;\n    --muted: #58667f;\n    --accent: #d81b47;\n    --accent-dark: #be1540;\n    --ok: #0b7a57;\n    --err: #b3123f;\n    --display: \"Bricolage Grotesque\", \"Be Vietnam Pro\", system-ui, sans-serif;\n    --body: \"Be Vietnam Pro\", system-ui, -apple-system, \"Segoe UI\", sans-serif;\n    color-scheme: light;\n  }\n  * { box-sizing: border-box; }\n  html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }\n  body {\n    margin: 0;\n    background: var(--paper);\n    color: var(--ink);\n    font-family: var(--body);\n    font-size: 16px;\n    line-height: 1.6;\n  }\n  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 20px; }\n  a { color: inherit; }\n  :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; border-radius: 6px; }\n\n  /* Đầu trang */\n  .top { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; }\n  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }\n  .brand svg { display: block; }\n  .brand span { font-family: var(--display); font-weight: 800; font-size: 1.3rem; letter-spacing: -0.02em; }\n  .nav { display: flex; gap: 4px; }\n  .nav a { padding: 8px 12px; color: var(--muted); text-decoration: none; font-size: .95rem; font-weight: 500; border-radius: 8px; }\n  .nav a:hover { color: var(--ink); background: var(--tint); }\n\n  /* Khu vực chính */\n  .hero { display: grid; gap: 0; padding: 20px 0 56px; }\n  h1 {\n    font-family: var(--display);\n    font-weight: 800;\n    font-size: clamp(2.1rem, 8vw, 3.7rem);\n    line-height: 1.04;\n    letter-spacing: -0.035em;\n    margin: 0;\n    text-wrap: balance;\n  }\n  .lead { color: var(--muted); font-size: 1.05rem; max-width: 46ch; margin: 18px 0 0; }\n\n  .form {\n    display: grid;\n    grid-template-columns: 1fr auto;\n    gap: 10px;\n    margin-top: 28px;\n    padding: 10px;\n    background: var(--surface);\n    border: 1.5px solid var(--line);\n    border-radius: 20px;\n    box-shadow: 0 14px 34px -18px rgba(20, 33, 61, .3);\n  }\n  .form:focus-within { border-color: var(--ink); }\n  .form input {\n    grid-column: 1;\n    min-width: 0;\n    height: 52px;\n    padding: 0 12px;\n    border: 0;\n    background: transparent;\n    color: var(--ink);\n    font: inherit;\n    font-size: 16px;\n    outline: none;\n  }\n  .form input::placeholder { color: #8c97ad; }\n  .paste {\n    width: 52px; height: 52px;\n    display: grid; place-items: center;\n    border: 0; border-radius: 12px;\n    background: var(--tint); color: var(--ink);\n    cursor: pointer;\n  }\n  .paste:hover { background: #dfe6f3; }\n  .go { grid-column: 1 / -1; }\n\n  .btn {\n    display: inline-flex; align-items: center; justify-content: center; gap: 10px;\n    height: 52px; padding: 0 26px;\n    border: 0; border-radius: 12px;\n    font: inherit; font-weight: 600; font-size: 1rem;\n    text-decoration: none; cursor: pointer;\n  }\n  .btn.primary { background: var(--accent); color: #fff; }\n  .btn.primary:hover { background: var(--accent-dark); }\n  .btn.ghost { background: transparent; color: var(--ink); border: 1.5px solid var(--line); }\n  .btn.ghost:hover { background: var(--tint); }\n  .btn[disabled] { opacity: .65; cursor: progress; }\n  .btn[hidden] { display: none; }\n  .spin {\n    width: 18px; height: 18px; border-radius: 50%;\n    border: 2.5px solid rgba(255, 255, 255, .4); border-top-color: #fff;\n    animation: rot .7s linear infinite;\n  }\n  .spin[hidden] { display: none; }\n  @keyframes rot { to { transform: rotate(360deg); } }\n\n  .status { min-height: 1.6em; margin: 14px 4px 0; font-size: .95rem; }\n  .status.err { color: var(--err); }\n  .status.ok { color: var(--ok); font-weight: 500; }\n  .trace { margin: 4px 4px 0; font-size: .8rem; color: var(--muted); word-break: break-word; }\n  .trace:empty { display: none; }\n\n  .perks { list-style: none; margin: 22px 0 0; padding: 0; display: grid; gap: 8px; color: var(--muted); font-size: .95rem; }\n  .perks li { display: flex; align-items: center; gap: 10px; }\n  .perks svg { flex: none; color: var(--ok); }\n  .perks-d { display: none; }\n\n  /* Khung xem trước và kết quả */\n  .stage { display: none; }\n  .stage.show { display: grid; grid-template-columns: 128px 1fr; gap: 18px; align-items: start; margin-top: 28px; }\n  .clip {\n    position: relative; width: 100%; aspect-ratio: 9 / 16;\n    border-radius: 26px; overflow: hidden;\n    background: var(--tint); border: 1.5px solid var(--line);\n  }\n  .clip img {\n    position: absolute; inset: 0; width: 100%; height: 100%;\n    object-fit: cover; opacity: 0; transition: opacity .35s ease;\n  }\n  .clip.ready img { opacity: 1; }\n  .idle {\n    position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 10px;\n    padding: 0 22px; text-align: center; color: var(--muted); font-size: .9rem; z-index: 2;\n  }\n  .idle svg { color: var(--ink); opacity: .6; }\n  .idle span { background: rgba(246, 248, 252, .92); padding: 6px 14px; border-radius: 999px; line-height: 1.4; }\n  .clip.ready .idle { display: none; }\n\n  /* Lớp watermark mẫu: quét sạch khi có video */\n  .wm {\n    position: absolute; inset: 0; overflow: hidden; z-index: 1;\n    clip-path: inset(0 0 0 0);\n    transition: clip-path .9s cubic-bezier(.7, 0, .2, 1) .55s;\n    pointer-events: none;\n  }\n  .wm-lines {\n    position: absolute; inset: -35%;\n    transform: rotate(-24deg);\n    display: grid; align-content: center; gap: 26px;\n    font-family: var(--display); font-weight: 800; font-size: 1.25rem;\n    color: #b6c1d9; white-space: nowrap; user-select: none;\n  }\n  .wm-lines span:nth-child(even) { margin-left: 64px; }\n  .clip.ready .wm { clip-path: inset(0 0 0 100%); }\n  .clip.ready .wm-lines { color: rgba(255, 255, 255, .78); text-shadow: 0 1px 6px rgba(0, 0, 0, .45); }\n  .edge {\n    position: absolute; top: 0; bottom: 0; left: 0; width: 3px; z-index: 3;\n    background: var(--accent); box-shadow: 0 0 16px 2px var(--accent);\n    opacity: 0; pointer-events: none;\n  }\n  .clip.ready .edge { animation: sweep .9s cubic-bezier(.7, 0, .2, 1) .55s both; }\n  @keyframes sweep {\n    0% { left: 0; opacity: 1; }\n    92% { opacity: 1; }\n    100% { left: 100%; opacity: 0; }\n  }\n\n  .result[hidden] { display: none; }\n  .r-author { margin: 0; color: var(--muted); font-size: .9rem; font-weight: 500; word-break: break-word; }\n  .r-title {\n    margin: 4px 0 0; font-family: var(--body); font-size: 1rem; font-weight: 600; line-height: 1.4;\n    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;\n  }\n  .chip {\n    display: inline-block; margin-top: 10px; padding: 2px 10px;\n    background: var(--tint); border-radius: 999px; font-size: .8rem; font-weight: 500; color: var(--muted);\n  }\n  .chip[hidden] { display: none; }\n  .r-actions { display: grid; gap: 8px; margin-top: 16px; }\n  .r-actions .btn { height: 48px; padding: 0 18px; width: 100%; }\n  .again {\n    justify-self: start; padding: 6px 0; border: 0; background: none;\n    color: var(--muted); font: inherit; font-size: .9rem; text-decoration: underline; cursor: pointer;\n  }\n  .again:hover { color: var(--ink); }\n\n  /* Các mục bên dưới */\n  .block { border-top: 1px solid var(--line); padding: 56px 0; }\n  .block h2 {\n    font-family: var(--display); font-weight: 800;\n    font-size: clamp(1.6rem, 5vw, 2.25rem); line-height: 1.15; letter-spacing: -0.025em;\n    margin: 0 0 28px;\n  }\n\n  .steps { list-style: none; margin: 0; padding: 0; display: grid; }\n  .steps li { display: grid; grid-template-columns: 52px 1fr; padding: 18px 0; border-top: 1px solid var(--line); }\n  .steps li:first-child { border-top: 0; padding-top: 0; }\n  .num { font-family: var(--display); font-weight: 800; font-size: 2rem; line-height: 1; color: var(--accent); }\n  .steps h3 { margin: 0 0 4px; font-size: 1.05rem; font-weight: 600; }\n  .steps p { margin: 0; color: var(--muted); max-width: 40ch; }\n\n  .split { display: grid; gap: 4px; }\n  .split h2 { margin-bottom: 20px; }\n  .feat { display: grid; grid-template-columns: 44px 1fr; gap: 16px; padding: 20px 0; border-top: 1px solid var(--line); }\n  .feat:first-of-type { border-top: 0; padding-top: 0; }\n  .feat .ico {\n    width: 44px; height: 44px; display: grid; place-items: center;\n    background: var(--tint); border-radius: 12px; color: var(--ink);\n  }\n  .feat h3 { margin: 0 0 2px; font-size: 1.05rem; font-weight: 600; }\n  .feat p { margin: 0; color: var(--muted); max-width: 52ch; }\n\n  details { border-top: 1px solid var(--line); }\n  details:last-of-type { border-bottom: 1px solid var(--line); }\n  summary {\n    list-style: none; cursor: pointer; padding: 18px 0;\n    display: flex; align-items: center; justify-content: space-between; gap: 16px;\n    font-weight: 600;\n  }\n  summary::-webkit-details-marker { display: none; }\n  summary svg { flex: none; transition: transform .2s ease; color: var(--muted); }\n  details[open] summary svg { transform: rotate(45deg); }\n  details p { margin: 0 0 18px; color: var(--muted); max-width: 60ch; }\n\n  footer { border-top: 1px solid var(--line); padding: 28px 0 44px; color: var(--muted); font-size: .88rem; }\n  footer p { margin: 0 0 6px; max-width: 70ch; }\n  footer strong { color: var(--ink); font-family: var(--display); font-size: 1rem; }\n\n  @media (min-width: 600px) {\n    .form { grid-template-columns: 1fr auto auto; }\n    .go { grid-column: auto; }\n  }\n  @media (min-width: 900px) {\n    .top { padding: 22px 0; }\n    .hero { grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 72px; align-items: center; padding: 52px 0 88px; }\n    .perks-d { display: grid; }\n    .perks-m { display: none; }\n    .stage, .stage.show { display: grid; grid-template-columns: 1fr; justify-items: center; gap: 22px; margin-top: 0; }\n    .clip { width: min(100%, 240px); }\n    .clip .wm-lines { font-size: 1.5rem; gap: 30px; }\n    .result { width: min(100%, 320px); }\n    .block { padding: 80px 0; }\n    .steps { grid-template-columns: repeat(3, 1fr); gap: 48px; }\n    .steps li { grid-template-columns: 1fr; gap: 14px; padding: 18px 0 0; border-top: 1.5px solid var(--ink); }\n    .steps li:first-child { border-top: 1.5px solid var(--ink); padding-top: 18px; }\n    .split { grid-template-columns: .8fr 1.2fr; gap: 72px; }\n    .split h2 { position: sticky; top: 24px; align-self: start; }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }\n  }\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <header class=\"top\">\n    <a class=\"brand\" href=\"/\" aria-label=\"Tải Sạch - trang chủ\">\n      <svg width=\"32\" height=\"32\" viewBox=\"0 0 32 32\" aria-hidden=\"true\">\n        <rect width=\"32\" height=\"32\" rx=\"9\" fill=\"#d81b47\"/>\n        <path d=\"M16 8v11m0 0-5-5m5 5 5-5M9 24h14\" stroke=\"#fff\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/>\n      </svg>\n      <span>Tải Sạch</span>\n    </a>\n    <nav class=\"nav\" aria-label=\"Điều hướng\">\n      <a href=\"#cach-dung\">Cách dùng</a>\n      <a href=\"#hoi-dap\">Hỏi đáp</a>\n    </nav>\n  </header>\n\n  <main>\n    <section class=\"hero\">\n      <div class=\"copy\">\n        <h1>Tải video TikTok không watermark</h1>\n        <p class=\"lead\">Dán link, nhận file MP4 sạch logo ở chất lượng cao nhất. Miễn phí, không cần đăng ký, dùng được ngay trên điện thoại.</p>\n\n        <div class=\"form\">\n          <input id=\"url\" type=\"url\" inputmode=\"url\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\"\n                 placeholder=\"Dán link video TikTok vào đây\" aria-label=\"Link video TikTok\">\n          <button id=\"paste\" class=\"paste\" type=\"button\" aria-label=\"Dán link từ bộ nhớ tạm\" title=\"Dán link\">\n            <svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"8\" y=\"3\" width=\"8\" height=\"4\" rx=\"1\"/><path d=\"M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2\"/></svg>\n          </button>\n          <button id=\"go\" class=\"btn primary go\" type=\"button\">\n            <span id=\"spin\" class=\"spin\" hidden></span>\n            <span id=\"goLabel\">Lấy video</span>\n          </button>\n        </div>\n        <div id=\"status\" class=\"status\" role=\"status\" aria-live=\"polite\"></div>\n        <div id=\"trace\" class=\"trace\"></div>\n\n        <ul class=\"perks perks-d\">\n          <li><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M20 6 9 17l-5-5\"/></svg>Không logo, không tên người đăng chạy trên màn hình</li>\n          <li><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M20 6 9 17l-5-5\"/></svg>Ưu tiên bản chất lượng cao nhất</li>\n          <li><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M20 6 9 17l-5-5\"/></svg>Không cần cài ứng dụng</li>\n        </ul>\n\n      </div>\n\n      <div id=\"stage\" class=\"stage\">\n        <div id=\"clip\" class=\"clip\">\n          <img id=\"thumb\" alt=\"Ảnh xem trước video\" referrerpolicy=\"no-referrer\">\n          <div class=\"idle\">\n            <svg width=\"36\" height=\"36\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z\"/></svg>\n            <span>Bản xem trước video sẽ hiện ở đây</span>\n          </div>\n          <div class=\"wm\" aria-hidden=\"true\">\n            <div class=\"wm-lines\">\n              <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n              <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n              <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n            </div>\n          </div>\n          <div class=\"edge\" aria-hidden=\"true\"></div>\n        </div>\n\n        <div id=\"result\" class=\"result\" hidden>\n          <p id=\"author\" class=\"r-author\"></p>\n          <h2 id=\"title\" class=\"r-title\"></h2>\n          <span id=\"dur\" class=\"chip\" hidden></span>\n          <div class=\"r-actions\">\n            <button id=\"dl\" class=\"btn primary\" type=\"button\">Tải video</button>\n            <a id=\"open\" class=\"btn ghost\" href=\"#\" target=\"_blank\" rel=\"noopener noreferrer\" hidden>Mở ở tab mới</a>\n            <button id=\"again\" class=\"again\" type=\"button\">Dán link khác</button>\n          </div>\n        </div>\n      </div>\n          <ul class=\"perks perks-m\">\n        <li><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M20 6 9 17l-5-5\"/></svg>Không logo, không tên người đăng chạy trên màn hình</li>\n        <li><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M20 6 9 17l-5-5\"/></svg>Ưu tiên bản chất lượng cao nhất</li>\n        <li><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M20 6 9 17l-5-5\"/></svg>Không cần cài ứng dụng</li>\n      </ul>\n    </section>\n\n    <section id=\"cach-dung\" class=\"block\" aria-labelledby=\"h-cach-dung\">\n      <h2 id=\"h-cach-dung\">Cách dùng</h2>\n      <ol class=\"steps\">\n        <li>\n          <span class=\"num\" aria-hidden=\"true\">1</span>\n          <div><h3>Sao chép link</h3><p>Mở video trong TikTok, bấm Chia sẻ rồi chọn Sao chép liên kết.</p></div>\n        </li>\n        <li>\n          <span class=\"num\" aria-hidden=\"true\">2</span>\n          <div><h3>Dán và lấy video</h3><p>Dán link vào ô phía trên rồi bấm Lấy video.</p></div>\n        </li>\n        <li>\n          <span class=\"num\" aria-hidden=\"true\">3</span>\n          <div><h3>Tải về máy</h3><p>Xem trước video rồi bấm Tải video. File MP4 sẽ nằm trong mục Tải xuống.</p></div>\n        </li>\n      </ol>\n    </section>\n\n    <section class=\"block\" aria-labelledby=\"h-vi-sao\">\n      <div class=\"split\">\n        <h2 id=\"h-vi-sao\">Gọn, sạch và nhanh</h2>\n        <div>\n          <div class=\"feat\">\n            <div class=\"ico\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4Z\"/><path d=\"M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z\"/></svg></div>\n            <div><h3>Sạch hoàn toàn</h3><p>Video không có logo TikTok và không có tên người đăng chạy trên màn hình.</p></div>\n          </div>\n          <div class=\"feat\">\n            <div class=\"ico\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"M7 15v-4l2 2 2-3 2 3 2-2v4\"/></svg></div>\n            <div><h3>Chất lượng gốc</h3><p>Ưu tiên bản HD cao nhất mà TikTok cung cấp. File được chuyển nguyên vẹn, không nén lại.</p></div>\n          </div>\n          <div class=\"feat\">\n            <div class=\"ico\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"7\" y=\"2\" width=\"10\" height=\"20\" rx=\"2.5\"/><path d=\"M11 18h2\"/></svg></div>\n            <div><h3>Làm cho điện thoại</h3><p>Giao diện thiết kế cho màn hình nhỏ, không quảng cáo và không bật cửa sổ lạ.</p></div>\n          </div>\n        </div>\n      </div>\n    </section>\n\n    <section id=\"hoi-dap\" class=\"block\" aria-labelledby=\"h-hoi-dap\">\n      <div class=\"split\">\n        <h2 id=\"h-hoi-dap\">Câu hỏi thường gặp</h2>\n        <div>\n          <details>\n            <summary>Dùng có mất phí không?<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M12 5v14M5 12h14\"/></svg></summary>\n            <p>Không. Công cụ miễn phí và không yêu cầu đăng ký tài khoản.</p>\n          </details>\n          <details>\n            <summary>Video được lưu ở đâu?<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M12 5v14M5 12h14\"/></svg></summary>\n            <p>File MP4 thường nằm trong mục Tải xuống của trình duyệt. Trên iPhone, hãy mở ứng dụng Tệp rồi vào thư mục Tải xuống.</p>\n          </details>\n          <details>\n            <summary>Vì sao đôi khi không tải được?<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M12 5v14M5 12h14\"/></svg></summary>\n            <p>Video có thể đã bị xóa, ở chế độ riêng tư, hoặc là bài đăng ảnh. Đôi khi dịch vụ lấy dữ liệu bị quá tải, hãy thử lại sau vài giây.</p>\n          </details>\n          <details>\n            <summary>Tôi có được đăng lại video không?<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M12 5v14M5 12h14\"/></svg></summary>\n            <p>Chỉ nên tải video của chính bạn hoặc video bạn được phép sử dụng. Video thuộc quyền của người sáng tạo, hãy xin phép và ghi nguồn khi đăng lại.</p>\n          </details>\n        </div>\n      </div>\n    </section>\n  </main>\n\n  <footer>\n    <p><strong>Tải Sạch</strong></p>\n    <p>Công cụ độc lập, không liên kết với TikTok. TikTok là nhãn hiệu của chủ sở hữu tương ứng.</p>\n    <p>Máy chủ không lưu video của bạn, file được chuyển thẳng tới thiết bị.</p>\n  </footer>\n</div>\n\n<script>\n  const $ = (id) => document.getElementById(id);\n  const input = $(\"url\"), go = $(\"go\"), goLabel = $(\"goLabel\"), spin = $(\"spin\");\n  const statusEl = $(\"status\"), traceEl = $(\"trace\");\n  const stage = $(\"stage\"), clip = $(\"clip\"), result = $(\"result\");\n  const dl = $(\"dl\"), openLink = $(\"open\"), again = $(\"again\"), pasteBtn = $(\"paste\");\n  const TIKTOK = /^https?:\\/\\/(?:[a-z0-9-]+\\.)*tiktok\\.com\\//i;\n  let current = null;\n\n  function say(msg, kind) {\n    statusEl.textContent = msg || \"\";\n    statusEl.className = \"status\" + (kind ? \" \" + kind : \"\");\n  }\n  function showTrace(lines) {\n    traceEl.textContent = lines && lines.length ? \"Chi tiết: \" + lines.join(\" | \") : \"\";\n  }\n  function setBusy(busy) {\n    go.disabled = busy;\n    spin.hidden = !busy;\n    goLabel.textContent = busy ? \"Đang lấy video\" : \"Lấy video\";\n  }\n  function reset() {\n    clip.classList.remove(\"ready\");\n    stage.classList.remove(\"show\");\n    result.hidden = true;\n    current = null;\n    showTrace([]);\n  }\n  function fmt(sec) {\n    sec = Math.round(sec);\n    return Math.floor(sec / 60) + \":\" + String(sec % 60).padStart(2, \"0\");\n  }\n  const abs = (u) => (!u ? \"\" : u.indexOf(\"http\") === 0 ? u : \"https://www.tikwm.com\" + (u[0] === \"/\" ? \"\" : \"/\") + u);\n\n  // Cách 1: nhờ máy chủ Cloudflare lấy video\n  async function viaWorker(url) {\n    const res = await fetch(\"/api/info\", {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ url }),\n    });\n    let data = {};\n    try { data = await res.json(); } catch (e) {}\n    if (!res.ok) {\n      const err = new Error(data.error || \"Máy chủ báo lỗi \" + res.status);\n      err.trace = data.trace || [];\n      err.userMessage = data.error;\n      throw err;\n    }\n    data.kind = \"worker\";\n    return data;\n  }\n\n  // Cách 2: trình duyệt trên điện thoại tự hỏi tikwm (dùng IP nhà mạng của bạn nên ít bị chặn hơn)\n  async function viaBrowser(url) {\n    const res = await fetch(\"https://www.tikwm.com/api/\", {\n      method: \"POST\",\n      body: new URLSearchParams({ url: url, hd: \"1\" }),\n    });\n    const j = await res.json();\n    if (j.code !== 0 || !j.data) throw new Error(j.msg || \"tikwm không trả về video\");\n    const d = j.data;\n    const src = abs(d.hdplay || d.play);\n    if (!src) throw new Error(\"không có link video\");\n    return {\n      kind: \"browser\",\n      src: src,\n      id: String(d.id || Date.now()),\n      title: d.title || \"Video TikTok\",\n      author: (d.author && d.author.unique_id) || \"\",\n      thumbnail: abs(d.cover || d.origin_cover),\n      duration: d.duration || null,\n    };\n  }\n\n  async function fetchVideo() {\n    const url = input.value.trim();\n    if (!url) { say(\"Hãy dán link video TikTok vào ô phía trên.\", \"err\"); input.focus(); return; }\n    if (!TIKTOK.test(url)) { say(\"Link không hợp lệ. Hãy dán link video từ TikTok.\", \"err\"); return; }\n\n    reset();\n    setBusy(true);\n    say(\"Đang lấy video...\");\n\n    try {\n      let info, notes = [];\n      try {\n        info = await viaWorker(url);\n      } catch (e) {\n        if (e.userMessage && /không hợp lệ/i.test(e.userMessage)) { say(e.userMessage, \"err\"); return; }\n        notes = (e.trace && e.trace.length) ? e.trace.slice() : [e.message];\n        say(\"Máy chủ chưa lấy được, đang thử cách khác...\");\n        try {\n          info = await viaBrowser(url);\n        } catch (e2) {\n          say(\"Không lấy được video. Video có thể đã bị xóa, ở chế độ riêng tư, hoặc cả hai cách đều bị chặn.\", \"err\");\n          showTrace(notes.concat(\"trình duyệt: \" + (e2.message || \"lỗi\")));\n          return;\n        }\n      }\n\n      current = Object.assign({ url: url }, info);\n      $(\"thumb\").src = info.thumbnail || \"\";\n      $(\"author\").textContent = info.author ? \"@\" + info.author : \"\";\n      $(\"title\").textContent = info.title;\n      const dur = $(\"dur\");\n      if (info.duration) { dur.textContent = fmt(info.duration); dur.hidden = false; } else { dur.hidden = true; }\n      if (info.kind === \"browser\") { openLink.href = info.src; openLink.hidden = false; }\n      else { openLink.hidden = true; }\n\n      result.hidden = false;\n      stage.classList.add(\"show\");\n      void clip.offsetWidth; // đảm bảo hiệu ứng quét watermark chạy lại mỗi lần\n      clip.classList.add(\"ready\");\n      say(\"Video đã sẵn sàng.\", \"ok\");\n      stage.scrollIntoView({ behavior: \"smooth\", block: \"nearest\" });\n    } catch (e) {\n      say(\"Không kết nối được. Kiểm tra mạng rồi thử lại.\", \"err\");\n    } finally {\n      setBusy(false);\n    }\n  }\n\n  async function saveVideo() {\n    if (!current) return;\n    const src = current.kind === \"worker\" ? \"/api/download?url=\" + encodeURIComponent(current.url) : current.src;\n    dl.disabled = true;\n    say(\"Đang tải video...\");\n    try {\n      const r = await fetch(src);\n      if (!r.ok) throw new Error((await r.text()) || \"lỗi \" + r.status);\n      const blob = await r.blob();\n      const a = document.createElement(\"a\");\n      a.href = URL.createObjectURL(blob);\n      a.download = \"tiktok_\" + current.id + \".mp4\";\n      document.body.appendChild(a);\n      a.click();\n      a.remove();\n      setTimeout(() => URL.revokeObjectURL(a.href), 10000);\n      say(\"Đã bắt đầu tải về. Xem file trong mục Tải xuống.\", \"ok\");\n    } catch (e) {\n      if (current.kind === \"browser\") {\n        window.open(current.src, \"_blank\", \"noopener\");\n        say(\"Video đã mở ở tab mới. Nhấn giữ vào video rồi chọn Tải xuống.\", \"err\");\n      } else {\n        say(\"Tải không thành công: \" + (e.message || \"lỗi không rõ\").slice(0, 120), \"err\");\n      }\n    } finally {\n      dl.disabled = false;\n    }\n  }\n\n  async function pasteLink() {\n    try {\n      const t = (await navigator.clipboard.readText()).trim();\n      if (!t) { say(\"Bộ nhớ tạm đang trống. Hãy sao chép link video TikTok trước.\", \"err\"); return; }\n      input.value = t;\n      reset();\n      say(\"\");\n      if (TIKTOK.test(t)) fetchVideo();\n    } catch (e) {\n      say(\"Trình duyệt không cho đọc bộ nhớ tạm. Hãy nhấn giữ vào ô và chọn Dán.\", \"err\");\n      input.focus();\n    }\n  }\n\n  go.addEventListener(\"click\", fetchVideo);\n  dl.addEventListener(\"click\", saveVideo);\n  pasteBtn.addEventListener(\"click\", pasteLink);\n  again.addEventListener(\"click\", () => { input.value = \"\"; reset(); say(\"\"); input.focus(); window.scrollTo({ top: 0, behavior: \"smooth\" }); });\n  input.addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\") fetchVideo(); });\n  input.addEventListener(\"input\", reset);\n</script>\n</body>\n</html>\n";
