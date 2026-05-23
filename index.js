const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://invidious.privacyredirect.com",
  "https://iv.ggtyler.dev",
  "https://invidious.perennialte.ch"
];

const PREFERRED_QUALITY = "high";
const MAX_SONGS = 100;

function extractPlaylistId(url) {
  const match = url.match(/[?&]list=([^&]+)/);
  return match ? match[1] : null;
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\?%*:|"<>]/g, "-").replace(/\s+/g, " ").trim().substring(0, 200);
}

function pickBestAudioStream(adaptiveFormats) {
  const audioStreams = adaptiveFormats.filter(f => f.type && f.type.toLowerCase().includes("audio"));
  if (!audioStreams || audioStreams.length === 0) return null;
  audioStreams.sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
  if (PREFERRED_QUALITY === "low") return audioStreams[audioStreams.length - 1];
  if (PREFERRED_QUALITY === "medium") return audioStreams[Math.floor(audioStreams.length / 2)];
  return audioStreams[0];
}

function getExtensionFromMime(mimeType) {
  if (!mimeType) return "webm";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  return "webm";
}

async function fetchWithFallback(path) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const resp = await gopeed.request.fetch(instance + path, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      if (resp && resp.body) {
        const data = JSON.parse(resp.body);
        if (!data.error) return { data, instance };
      }
    } catch (e) { continue; }
  }
  throw new Error("All Invidious instances failed. Try again later.");
}

async function getAudioStream(videoId, instance) {
  try {
    const resp = await gopeed.request.fetch(
      `${instance}/api/v1/videos/${videoId}?fields=title,adaptiveFormats,formatStreams`,
      { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
    );
    if (!resp || !resp.body) return null;
    const vData = JSON.parse(resp.body);
    if (vData.error) return null;
    if (vData.adaptiveFormats && vData.adaptiveFormats.length > 0) {
      const best = pickBestAudioStream(vData.adaptiveFormats);
      if (best) return { stream: best, title: vData.title };
    }
    if (vData.formatStreams && vData.formatStreams.length > 0) {
      return { stream: vData.formatStreams[vData.formatStreams.length - 1], title: vData.title };
    }
  } catch (e) { return null; }
  return null;
}

gopeed.events.onResolve(async (ctx) => {
  const url = ctx.req.url;
  const playlistId = extractPlaylistId(url);
  if (!playlistId) throw new Error("No playlist ID found in URL.");

  const { data: playlistMeta, instance: workingInstance } = await fetchWithFallback(
    `/api/v1/playlists/${playlistId}?fields=title,videoCount,videos`
  );

  const playlistTitle = playlistMeta.title || "YouTube Playlist";
  let videos = (playlistMeta.videos || []).slice(0, MAX_SONGS);
  const files = [];
  let trackNumber = 1;

  for (const video of videos) {
    const videoId = video.videoId;
    if (!videoId) continue;
    const result = await getAudioStream(videoId, workingInstance);
    if (result && result.stream && result.stream.url) {
      const { stream, title } = result;
      const ext = getExtensionFromMime(stream.type);
      const filename = `${String(trackNumber).padStart(2, "0")} - ${sanitizeFilename(title || video.title || "Track")}.${ext}`;
      files.push({
        name: filename,
        req: {
          url: stream.url,
          headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.youtube.com/" }
        }
      });
      trackNumber++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (files.length === 0) throw new Error("No audio streams found. Playlist may be private.");
  return { name: sanitizeFilename(playlistTitle), files };
});
