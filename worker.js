/**
 * Tải video TikTok không watermark - Cloudflare Worker (MỘT FILE, tự chứa cả giao diện).
 * Không cần thư viện, không cần build. Trang web ở "/", API ở "/api/*".
 */

const TIKTOK_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\//i;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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

async function callApi(url) {
  const res = await fetch("https://www.tikwm.com/api/?hd=1&url=" + encodeURIComponent(url), {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  return res.json();
}

async function lookup(url) {
  let j = await callApi(url);
  // tikwm giới hạn 1 yêu cầu/giây: đợi rồi thử lại một lần
  if (j.code !== 0 && /limit|second/i.test(String(j.msg || ""))) {
    await sleep(1200);
    j = await callApi(url);
  }
  if (j.code !== 0 || !j.data) throw new Error(j.msg || "not found");
  const d = j.data;
  const src = absolute(d.hdplay || d.play);
  if (!src) throw new Error("no video");
  return {
    id: String(d.id || Date.now()),
    src,
    title: d.title || "Video TikTok",
    author: (d.author && d.author.unique_id) || "",
    thumbnail: absolute(d.cover || d.origin_cover),
    duration: d.duration || null,
  };
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
      height: null,
    });
  } catch (e) {
    return json(
      {
        error:
          "Không lấy được video. Video có thể đã bị xóa, ở chế độ riêng tư, hoặc dịch vụ đang bận. Hãy thử lại sau vài giây.",
      },
      422
    );
  }
}

async function handleDownload(searchParams) {
  const url = String(searchParams.get("url") || "").trim();
  if (!TIKTOK_URL.test(url)) return text("Link không hợp lệ.", 400);
  try {
    const v = await lookup(url);
    const upstream = await fetch(v.src, {
      headers: { "User-Agent": UA, Referer: "https://www.tikwm.com/" },
    });
    if (!upstream.ok || !upstream.body) throw new Error("upstream");
    const headers = {
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="tiktok_' + v.id + '.mp4"',
      "Cache-Control": "no-store",
    };
    const len = upstream.headers.get("Content-Length");
    if (len) headers["Content-Length"] = len;
    return new Response(upstream.body, { headers });
  } catch (e) {
    return text("Không tải được video. Hãy thử lại sau vài giây.", 502);
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

const PAGE = "<!doctype html>\n<html lang=\"vi\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Tải video TikTok không watermark</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&display=swap\" rel=\"stylesheet\">\n<style>\n  :root {\n    --bg: #e8ebf4;\n    --ink: #161633;\n    --muted: #5b5f80;\n    --line: #c9cee3;\n    --accent: #ff2e6e;\n    --accent-ink: #ffffff;\n    --panel: #f7f8fc;\n    --ok: #0f7a55;\n    --err: #b3123f;\n  }\n  * { box-sizing: border-box; }\n  html { -webkit-text-size-adjust: 100%; }\n  body {\n    margin: 0;\n    background: var(--bg);\n    color: var(--ink);\n    font-family: \"Bricolage Grotesque\", system-ui, -apple-system, \"Segoe UI\", sans-serif;\n    line-height: 1.5;\n  }\n  main {\n    max-width: 1040px;\n    margin: 0 auto;\n    padding: 56px 24px 40px;\n    display: grid;\n    grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);\n    gap: 56px;\n    align-items: center;\n    min-height: 100vh;\n  }\n  h1 {\n    font-size: clamp(2.4rem, 6vw, 4.2rem);\n    line-height: 1.02;\n    letter-spacing: -0.03em;\n    font-weight: 800;\n    margin: 0 0 18px;\n  }\n  .lead { color: var(--muted); font-size: 1.1rem; max-width: 46ch; margin: 0 0 32px; }\n\n  .field {\n    display: flex;\n    gap: 8px;\n    background: var(--panel);\n    border: 2px solid var(--ink);\n    border-radius: 999px;\n    padding: 6px;\n  }\n  .field:focus-within { outline: 3px solid var(--accent); outline-offset: 3px; }\n  .field input {\n    flex: 1;\n    min-width: 0;\n    border: 0;\n    background: transparent;\n    font: inherit;\n    font-size: 1rem;\n    padding: 0 18px;\n    color: var(--ink);\n    outline: none;\n  }\n  .field input::placeholder { color: #8a8eab; }\n  button, .btn {\n    font: inherit;\n    font-weight: 600;\n    border: 0;\n    border-radius: 999px;\n    padding: 14px 24px;\n    background: var(--accent);\n    color: var(--accent-ink);\n    cursor: pointer;\n    text-decoration: none;\n    display: inline-block;\n    text-align: center;\n  }\n  button:hover, .btn:hover { filter: brightness(0.94); }\n  button:focus-visible, .btn:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }\n  button[disabled] { opacity: .6; cursor: progress; }\n\n  .status { min-height: 1.6em; margin: 14px 6px 0; font-size: .95rem; }\n  .status.err { color: var(--err); }\n  .status.ok { color: var(--ok); }\n\n  .how { margin: 36px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: .95rem; }\n  .how li { padding: 10px 0; border-top: 1px solid var(--line); }\n  .how li:last-child { border-bottom: 1px solid var(--line); }\n\n  .legal { font-size: .8rem; color: var(--muted); margin-top: 20px; max-width: 56ch; }\n\n  /* Khung điện thoại: lúc chờ hiện lớp watermark mờ, có kết quả thì lớp này biến mất */\n  .phone {\n    position: relative;\n    width: min(100%, 320px);\n    aspect-ratio: 9 / 16;\n    margin: 0 auto;\n    border: 2px solid var(--ink);\n    border-radius: 36px;\n    background: var(--panel);\n    overflow: hidden;\n  }\n  .phone .mark {\n    position: absolute; inset: -30%;\n    transform: rotate(-24deg);\n    display: grid;\n    align-content: center;\n    gap: 26px;\n    font-weight: 800;\n    font-size: 1.5rem;\n    color: #c4c9e2;\n    white-space: nowrap;\n    transition: opacity .5s ease;\n    user-select: none;\n  }\n  .phone .mark span:nth-child(even) { margin-left: 70px; }\n  .phone.ready .mark { opacity: 0; }\n  .phone img {\n    position: absolute; inset: 0; width: 100%; height: 100%;\n    object-fit: cover;\n    opacity: 0;\n    transition: opacity .4s ease;\n  }\n  .phone.ready img { opacity: 1; }\n  .phone .meta {\n    position: absolute; left: 0; right: 0; bottom: 0;\n    padding: 56px 18px 18px;\n    color: #fff;\n    background: linear-gradient(transparent, rgba(10,10,30,.82));\n    opacity: 0;\n    transition: opacity .4s ease;\n  }\n  .phone.ready .meta { opacity: 1; }\n  .meta b { display: block; font-size: 1rem; }\n  .meta p {\n    margin: 4px 0 0; font-size: .85rem; opacity: .9;\n    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;\n  }\n  .get { margin-top: 20px; text-align: center; }\n  .get .btn { width: min(100%, 320px); }\n  .get[hidden] { display: none; }\n\n  @media (max-width: 820px) {\n    main { grid-template-columns: 1fr; gap: 36px; padding-top: 36px; min-height: 0; }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    * { transition: none !important; }\n  }\n</style>\n</head>\n<body>\n<main>\n  <section>\n    <h1>Dán link. Nhận video không dính logo.</h1>\n    <p class=\"lead\">Tải video TikTok về máy ở chất lượng cao nhất, không có watermark và tên người đăng chạy trên màn hình.</p>\n\n    <div class=\"field\">\n      <input id=\"url\" type=\"url\" inputmode=\"url\" autocomplete=\"off\"\n             placeholder=\"https://www.tiktok.com/@.../video/...\" aria-label=\"Link video TikTok\">\n      <button id=\"go\" type=\"button\">Lấy video</button>\n    </div>\n    <div id=\"status\" class=\"status\" role=\"status\" aria-live=\"polite\"></div>\n\n    <ol class=\"how\">\n      <li>Mở video trên TikTok, chọn Chia sẻ, rồi Sao chép liên kết.</li>\n      <li>Dán liên kết vào ô phía trên và bấm Lấy video.</li>\n      <li>Kiểm tra bản xem trước rồi bấm Tải video.</li>\n    </ol>\n    <p class=\"legal\">Chỉ tải video của bạn hoặc video bạn được phép sử dụng. Khi đăng lại, hãy ghi nguồn và tôn trọng bản quyền của người sáng tạo.</p>\n  </section>\n\n  <section>\n    <div id=\"phone\" class=\"phone\" aria-live=\"polite\">\n      <div class=\"mark\" aria-hidden=\"true\">\n        <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n        <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n        <span>@tên_người_dùng</span><span>@tên_người_dùng</span><span>@tên_người_dùng</span>\n      </div>\n      <img id=\"thumb\" alt=\"Ảnh xem trước video\" referrerpolicy=\"no-referrer\">\n      <div class=\"meta\"><b id=\"author\"></b><p id=\"title\"></p></div>\n    </div>\n    <div id=\"get\" class=\"get\" hidden>\n      <a id=\"dl\" class=\"btn\" href=\"#\">Tải video</a>\n    </div>\n  </section>\n</main>\n\n<script>\n  const $ = (id) => document.getElementById(id);\n  const input = $(\"url\"), go = $(\"go\"), statusEl = $(\"status\");\n  const phone = $(\"phone\"), get = $(\"get\");\n\n  function say(msg, kind) {\n    statusEl.textContent = msg || \"\";\n    statusEl.className = \"status\" + (kind ? \" \" + kind : \"\");\n  }\n\n  function reset() {\n    phone.classList.remove(\"ready\");\n    get.hidden = true;\n  }\n\n  async function fetchVideo() {\n    const url = input.value.trim();\n    if (!url) { say(\"Hãy dán link video TikTok vào ô trên.\", \"err\"); input.focus(); return; }\n\n    reset();\n    go.disabled = true;\n    say(\"Đang lấy video...\");\n\n    try {\n      const res = await fetch(\"/api/info\", {\n        method: \"POST\",\n        headers: { \"Content-Type\": \"application/json\" },\n        body: JSON.stringify({ url }),\n      });\n      const data = await res.json();\n      if (!res.ok) { say(data.error || \"Có lỗi xảy ra, hãy thử lại.\", \"err\"); return; }\n\n      $(\"thumb\").src = data.thumbnail || \"\";\n      $(\"author\").textContent = data.author ? \"@\" + data.author : \"\";\n      $(\"title\").textContent = data.title;\n      $(\"dl\").href = \"/api/download?url=\" + encodeURIComponent(url);\n      phone.classList.add(\"ready\");\n      get.hidden = false;\n\n      const parts = [];\n      if (data.height) parts.push(data.height + \"p\");\n      if (data.duration) parts.push(Math.round(data.duration) + \" giây\");\n      say(\"Đã sẵn sàng\" + (parts.length ? \" (\" + parts.join(\", \") + \")\" : \"\") + \".\", \"ok\");\n    } catch (e) {\n      say(\"Không kết nối được tới máy chủ. Kiểm tra mạng rồi thử lại.\", \"err\");\n    } finally {\n      go.disabled = false;\n    }\n  }\n\n  go.addEventListener(\"click\", fetchVideo);\n  input.addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\") fetchVideo(); });\n  input.addEventListener(\"input\", reset);\n</script>\n</body>\n</html>\n";
