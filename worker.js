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

const PAGE = "<!doctype html>\n<html lang=\"vi\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Tải video TikTok không watermark</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&display=swap\" rel=\"stylesheet\">\n<style>\n  :root {\n    --bg: #e8ebf4;\n    --ink: #161633;\n    --muted: #5b5f80;\n    --line: #c9cee3;\n    --accent: #ff2e6e;\n    --accent-ink: #ffffff;\n    --panel: #f7f8fc;\n    --ok: #0f7a55;\n    --err: #b3123f;\n  }\n  * { box-sizing: border-box; }\n  html { -webkit-text-size-adjust: 100%; }\n  body {\n    margin: 0;\n    background: var(--bg);\n    color: var(--ink);\n    font-family: \"Bricolage Grotesque\", system-ui, -apple-system, \"Segoe UI\", sans-serif;\n    line-height: 1.5;\n  }\n  main {\n    max-width: 1040px;\n    margin: 0 auto;\n    padding: 56px 24px 40px;\n    display: grid;\n    grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);\n    gap: 56px;\n    align-items: center;\n    min-height: 100vh;\n  }\n  h1 {\n    font-size: clamp(2.4rem, 6vw, 4.2rem);\n    line-height: 1.02;\n    letter-spacing: -0.03em;\n    font-weight: 800;\n    margin: 0 0 18px;\n  }\n  .lead { color: var(--muted); font-size: 1.1rem; max-width: 46ch; margin: 0 0 32px; }\n\n  .field {\n    display: flex;\n    gap: 8px;\n    background: var(--panel);\n    border: 2px solid var(--ink);\n    border-radius: 999px;\n    padding: 6px;\n  }\n  .field:focus-within { outline: 3px solid var(--accent); outline-offset: 3px; }\n  .field input {\n    flex: 1;\n    min-width: 0;\n    border: 0;\n    background: transparent;\n    font: inherit;\n    font-size: 1rem;\n    padding: 0 18px;\n    color: var(--ink);\n    outline: none;\n  }\n  .field input::placeholder { color: #8a8eab; }\n  button, .btn {\n    font: inherit;\n    font-weight: 600;\n    border: 0;\n    border-radius: 999px;\n    padding: 14px 24px;\n    background: var(--accent);\n    color: var(--accent-ink);\n    cursor: pointer;\n    text-decoration: none;\n    display: inline-block;\n    text-align: center;\n  }\n  button:hover, .btn:hover { filter: brightness(0.94); }\n  button:focus-visible, .btn:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }\n  button[disabled] { opacity: .6; cursor: progress; }\n\n  .status { min-height: 1.6em; margin: 14px 6px 0; font-size: .95rem; }\n  .status.err { color: var(--err); }\n  .status.ok { color: var(--ok); }\n\n  .how { margin: 36px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: .95rem; }\n  .how li { padding: 10px 0; border-top: 1px solid var(--line); }\n  .how li:last-child { border-bottom: 1px solid var(--line); }\n\n  .legal { font-size: .8rem; color: var(--muted); margin-top: 20px; max-width: 56ch; }\n\n  /* Khung điện thoại: lúc chờ hiện lớp watermark mờ, có kết quả thì lớp này biến mất */\n  .phone {\n    position: relative;\n    width: min(100%, 320px);\n    aspect-ratio: 9 / 16;\n    margin: 0 auto;\n    border: 2px solid var(--ink);\n    border-radius: 36px;\n    background: var(--panel);\n    overflow: hidden;\n  }\n  .phone .mark {\n    position: absolute; inset: -30%;\n    transform: rotate(-24deg);\n    display: grid;\n    align-content: center;\n    gap: 26px;\n    font-weight: 800;\n    font-size: 1.5rem;\n    color: #c4c9e2;\n    white-space: nowrap;\n    transition: opacity .5s ease;\n    user-select: none;\n  }\n  .phone .mark span:nth-child(even) { margin-left: 70px; }\n  .phone.ready .mark { opacity: 0; }\n  .phone img {\n    position: absolute; inset: 0; width: 100%; height: 100%;\n    object-fit: cover;\n    opacity: 0;\n    transition: opacity .4s ease;\n  }\n  .phone.ready img { opacity: 1; }\n  .phone .meta {\n    position: absolute; left: 0; right: 0; bottom: 0;\n    padding: 56px 18px 18px;\n    color: #fff;\n    background: linear-gradient(transparent, rgba(10,10,30,.82));\n    opacity: 0;\n    transition: opacity .4s ease;\n  }\n  .phone.ready .meta { opacity: 1; }\n  .meta b { display: block; font-size: 1rem; }\n  .meta p {\n    margin: 4px 0 0; font-size: .85rem; opacity: .9;\n    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;\n  }\n  .get { margin-top: 20px; text-align: center; }\n  .get .btn { width: min(100%, 320px); }\n  .get[hidden] { display: none; }\n\n  .trace { margin: 6px 6px 0; font-size: .8rem; color: var(--muted); word-break: break-word; }\n  .trace:empty { display: none; }\n  .get { display: flex; flex-direction: column; align-items: center; gap: 10px; }\n  .btn.ghost { background: transparent; color: var(--ink); border: 2px solid var(--ink); }\n  .btn[hidden] { display: none; }\n  @media (max-width: 820px) {\n    main { grid-template-columns: 1fr; gap: 36px; padding-top: 36px; min-height: 0; }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    * { transition: none !important; }\n  }\n</style>\n</head>\n<body>\n<main>\n  <section>\n    <h1>Dán link. Nhận video không dính logo.</h1>\n    <p class=\"lead\">Tải video TikTok về máy ở chất lượng cao nhất, không có watermark và tên người đăng chạy trên màn hình.</p>\n\n    <div class=\"field\">\n      <input id=\"url\" type=\"url\" inputmode=\"url\" autocomplete=\"off\"\n             placeholder=\"https://www.tiktok.com/@.../video/...\" aria-label=\"Link video TikTok\">\n      <button id=\"go\" type=\"button\">Lấy video</button>\n    </div>\n    <div id=\"status\" class=\"status\" role=\"status\" aria-live=\"polite\"></div>\n    <div id=\"trace\" class=\"trace\"></div>\n\n    <ol class=\"how\">\n      <li>Mở video trên TikTok, chọn Chia sẻ, rồi Sao chép liên kết.</li>\n      <li>Dán liên kết vào ô phía trên và bấm Lấy video.</li>\n      <li>Kiểm tra bản xem trước rồi bấm Tải video.</li>\n    </ol>\n    <p class=\"legal\">Chỉ tải video của bạn hoặc video bạn được phép sử dụng. Khi đăng lại, hãy ghi nguồn và tôn trọng bản quyền của người sáng tạo.</p>\n  </section>\n\n  <section>\n    <div id=\"phone\" class=\"phone\" aria-live=\"polite\">\n      <div class=\"mark\" aria-hidden=\"true\">\n        <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n        <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n        <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n      </div>\n      <img id=\"thumb\" alt=\"Ảnh xem trước video\" referrerpolicy=\"no-referrer\">\n      <div class=\"meta\"><b id=\"author\"></b><p id=\"title\"></p></div>\n    </div>\n    <div id=\"get\" class=\"get\" hidden>\n      <button id=\"dl\" class=\"btn\" type=\"button\">Tải video</button>\n      <a id=\"open\" class=\"btn ghost\" href=\"#\" target=\"_blank\" rel=\"noopener noreferrer\" hidden>Mở video ở tab mới</a>\n    </div>\n  </section>\n</main>\n\n<script>\n  const $ = (id) => document.getElementById(id);\n  const input = $(\"url\"), go = $(\"go\"), statusEl = $(\"status\"), traceEl = $(\"trace\");\n  const phone = $(\"phone\"), get = $(\"get\"), dl = $(\"dl\"), openLink = $(\"open\");\n  let current = null;\n\n  function say(msg, kind) {\n    statusEl.textContent = msg || \"\";\n    statusEl.className = \"status\" + (kind ? \" \" + kind : \"\");\n  }\n  function showTrace(lines) {\n    traceEl.textContent = lines && lines.length ? \"Chi tiết: \" + lines.join(\" | \") : \"\";\n  }\n  function reset() {\n    phone.classList.remove(\"ready\");\n    get.hidden = true;\n    current = null;\n    showTrace([]);\n  }\n  const abs = (u) => (!u ? \"\" : u.indexOf(\"http\") === 0 ? u : \"https://www.tikwm.com\" + (u[0] === \"/\" ? \"\" : \"/\") + u);\n\n  // Cách 1: nhờ máy chủ Cloudflare lấy video\n  async function viaWorker(url) {\n    const res = await fetch(\"/api/info\", {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ url }),\n    });\n    let data = {};\n    try { data = await res.json(); } catch (e) {}\n    if (!res.ok) {\n      const err = new Error(data.error || \"Máy chủ báo lỗi \" + res.status);\n      err.trace = data.trace || [];\n      err.userMessage = data.error;\n      throw err;\n    }\n    data.kind = \"worker\";\n    return data;\n  }\n\n  // Cách 2: trình duyệt trên điện thoại tự hỏi tikwm (dùng IP nhà mạng của bạn nên ít bị chặn hơn)\n  async function viaBrowser(url) {\n    const res = await fetch(\"https://www.tikwm.com/api/\", {\n      method: \"POST\",\n      body: new URLSearchParams({ url: url, hd: \"1\" }),\n    });\n    const j = await res.json();\n    if (j.code !== 0 || !j.data) throw new Error(j.msg || \"tikwm không trả về video\");\n    const d = j.data;\n    const src = abs(d.hdplay || d.play);\n    if (!src) throw new Error(\"không có link video\");\n    return {\n      kind: \"browser\",\n      src: src,\n      id: String(d.id || Date.now()),\n      title: d.title || \"Video TikTok\",\n      author: (d.author && d.author.unique_id) || \"\",\n      thumbnail: abs(d.cover || d.origin_cover),\n      duration: d.duration || null,\n    };\n  }\n\n  async function fetchVideo() {\n    const url = input.value.trim();\n    if (!url) { say(\"Hãy dán link video TikTok vào ô trên.\", \"err\"); input.focus(); return; }\n\n    reset();\n    go.disabled = true;\n    say(\"Đang lấy video...\");\n\n    try {\n      let info, notes = [];\n      try {\n        info = await viaWorker(url);\n      } catch (e) {\n        if (e.userMessage && /không hợp lệ/i.test(e.userMessage)) { say(e.userMessage, \"err\"); return; }\n        notes = (e.trace && e.trace.length) ? e.trace.slice() : [e.message];\n        say(\"Máy chủ chưa lấy được, đang thử cách khác...\");\n        try {\n          info = await viaBrowser(url);\n        } catch (e2) {\n          say(\"Không lấy được video. Video có thể đã xóa, ở chế độ riêng tư, hoặc cả hai cách đều bị chặn.\", \"err\");\n          showTrace(notes.concat(\"trình duyệt: \" + (e2.message || \"lỗi\")));\n          return;\n        }\n      }\n\n      current = Object.assign({ url: url }, info);\n      $(\"thumb\").src = info.thumbnail || \"\";\n      $(\"author\").textContent = info.author ? \"@\" + info.author : \"\";\n      $(\"title\").textContent = info.title;\n      if (info.kind === \"browser\") { openLink.href = info.src; openLink.hidden = false; }\n      else { openLink.hidden = true; }\n      phone.classList.add(\"ready\");\n      get.hidden = false;\n      say(\"Đã sẵn sàng\" + (info.duration ? \" (\" + Math.round(info.duration) + \" giây)\" : \"\") + \".\", \"ok\");\n    } catch (e) {\n      say(\"Không kết nối được. Kiểm tra mạng rồi thử lại.\", \"err\");\n    } finally {\n      go.disabled = false;\n    }\n  }\n\n  async function saveVideo() {\n    if (!current) return;\n    const src = current.kind === \"worker\" ? \"/api/download?url=\" + encodeURIComponent(current.url) : current.src;\n    dl.disabled = true;\n    say(\"Đang tải video...\");\n    try {\n      const r = await fetch(src);\n      if (!r.ok) throw new Error((await r.text()) || \"lỗi \" + r.status);\n      const blob = await r.blob();\n      const a = document.createElement(\"a\");\n      a.href = URL.createObjectURL(blob);\n      a.download = \"tiktok_\" + current.id + \".mp4\";\n      document.body.appendChild(a);\n      a.click();\n      a.remove();\n      setTimeout(() => URL.revokeObjectURL(a.href), 10000);\n      say(\"Đã bắt đầu tải về. Xem trong mục Tải xuống của trình duyệt.\", \"ok\");\n    } catch (e) {\n      if (current.kind === \"browser\") {\n        window.open(current.src, \"_blank\", \"noopener\");\n        say(\"Video đã mở ở tab mới. Nhấn giữ vào video rồi chọn Tải xuống.\", \"err\");\n      } else {\n        say(\"Tải không thành công: \" + (e.message || \"lỗi không rõ\").slice(0, 120), \"err\");\n      }\n    } finally {\n      dl.disabled = false;\n    }\n  }\n\n  go.addEventListener(\"click\", fetchVideo);\n  dl.addEventListener(\"click\", saveVideo);\n  input.addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\") fetchVideo(); });\n  input.addEventListener(\"input\", reset);\n</script>\n</body>\n</html>\n";
