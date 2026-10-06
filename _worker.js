/**
 * Tải video TikTok không watermark - Cloudflare Worker (một file).
 * Cloudflare Pages (advanced mode): API ở "/api/*", còn lại là file tĩnh trong thư mục này.
 * Dùng API của tikwm.com để lấy link video không watermark.
 */

const TIKTOK_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\//i;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const absolute = (u) =>
  !u ? "" : u.startsWith("http") ? u : "https://www.tikwm.com" + (u.startsWith("/") ? "" : "/") + u;

async function lookup(url) {
  const res = await fetch("https://www.tikwm.com/api/?hd=1&url=" + encodeURIComponent(url), {
    headers: { "User-Agent": UA },
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data) throw new Error(json.msg || "not found");
  const d = json.data;
  const src = absolute(d.hdplay || d.play);
  if (!src) throw new Error("no video");
  return {
    id: d.id || String(Date.now()),
    src,
    title: d.title || "Video TikTok",
    author: (d.author && d.author.unique_id) || "",
    thumbnail: absolute(d.cover || d.origin_cover),
    duration: d.duration || null,
  };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const text = (msg, status) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === "POST" && pathname === "/api/info") {
      let body = {};
      try {
        body = await request.json();
      } catch {}
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
      } catch {
        return json(
          {
            error:
              "Không lấy được video. Video có thể đã bị xóa, ở chế độ riêng tư, hoặc dịch vụ đang bận. Hãy thử lại sau vài giây.",
          },
          422
        );
      }
    }

    if (request.method === "GET" && pathname === "/api/download") {
      const url = String(searchParams.get("url") || "").trim();
      if (!TIKTOK_URL.test(url)) return text("Link không hợp lệ.", 400);
      try {
        const v = await lookup(url);
        const upstream = await fetch(v.src, { headers: { "User-Agent": UA } });
        if (!upstream.ok || !upstream.body) throw new Error("upstream");
        const headers = {
          "Content-Type": "video/mp4",
          "Content-Disposition": 'attachment; filename="tiktok_' + v.id + '.mp4"',
          "Cache-Control": "no-store",
        };
        const len = upstream.headers.get("Content-Length");
        if (len) headers["Content-Length"] = len;
        return new Response(upstream.body, { headers });
      } catch {
        return text("Không tải được video. Hãy thử lại sau.", 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
