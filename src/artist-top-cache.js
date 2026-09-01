/**
 * Cloudflare KV artist-top packs (24h TTL on the Worker).
 */

const BASE = "/api/artist-top";

export async function fetchArtistTopCache(neteaseArtistId) {
  const id = String(neteaseArtistId || "").trim();
  if (!/^\d+$/.test(id)) return null;
  try {
    const res = await fetch(`${BASE}?id=${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok || !data?.hit || !Array.isArray(data.songs) || !data.songs.length) {
      return null;
    }
    return {
      neteaseArtistId: data.neteaseArtistId || id,
      name: data.name || "",
      avatar: data.avatar || "",
      songs: data.songs,
      cachedAt: data.cachedAt || null,
      fromKvCache: true,
    };
  } catch {
    return null;
  }
}

export function putArtistTopCache(pack) {
  const id = String(pack?.neteaseArtistId || "").trim();
  if (!/^\d+$/.test(id) || !pack?.songs?.length) return;
  const body = {
    neteaseArtistId: id,
    name: pack.name || pack.neteaseArtistName || "",
    avatar: pack.avatar || "",
    songs: pack.songs.slice(0, 100),
  };
  try {
    void fetch(BASE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
