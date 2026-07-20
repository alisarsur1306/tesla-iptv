import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { handleProxy, handleXtreamApi, handleStream, isManaged, getRequiredKey, isKeyValid } from './proxy/hlsProxy.mjs'

// Same-origin /api/proxy middleware so the browser never hits the IPTV
// server directly (the upstream HLS endpoints send no CORS headers).
// When ACCESS_KEY is set, /config.json is gated in dev too (same rule as server.js).
function hlsProxyPlugin(): Plugin {
  return {
    name: 'hls-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/proxy')) {
          void handleProxy(req, res)
          return
        }
        if (req.url?.startsWith('/api/stream')) {
          void handleStream(req, res)
          return
        }
        if (req.url?.startsWith('/api/xt')) {
          void handleXtreamApi(req, res)
          return
        }
        if (req.url?.startsWith('/config.json')) {
          const key = new URL(req.url, 'http://localhost').searchParams.get('key') || ''
          if (getRequiredKey() && !isKeyValid(key)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'Invalid or missing access key', status: 403 }))
            return
          }
          // Managed mode: report only whether the server holds an account, never it.
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ managed: isManaged() }))
          return
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react(), hlsProxyPlugin()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
