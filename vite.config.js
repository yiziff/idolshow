import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api/rank": {
        target: "http://127.0.0.1:8789",
        changeOrigin: true,
      },
      "/api/itunes": {
        target: "https://itunes.apple.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/itunes/, ""),
      },
      "/api/netease": {
        target: process.env.NETEASE_PROXY || "https://heipaclub.com",
        changeOrigin: true,
        rewrite: (p) =>
          (process.env.NETEASE_PROXY || "https://heipaclub.com").includes("heipaclub.com")
            ? p
            : p.replace(/^\/api\/netease/, ""),
      },
    },
  },
});
