import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'http';

export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      // Permissive CSP so the rrweb replay iframe can load external fonts, images,
      // and scripts that were referenced by the recorded page.
      'Content-Security-Policy': [
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
        'img-src * data: blob:',
        'font-src * data:',
        'frame-src *',
        'connect-src *',
        'worker-src * blob:',
      ].join('; '),
      // Relax cross-origin isolation so sub-frames can communicate freely
      'Cross-Origin-Embedder-Policy': 'unsafe-none',
      'Cross-Origin-Opener-Policy': 'unsafe-none',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
    proxy: {
      '/api': {
        target: 'https://whatfix.com/service/analytics',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req: IncomingMessage & { url?: string }) => {
            // Forward the cookie sent by the browser as x-forwarded-cookie
            const forwarded = (req as IncomingMessage & { headers: Record<string, string | string[] | undefined> }).headers['x-forwarded-cookie'];
            if (forwarded) {
              const cookieVal = Array.isArray(forwarded) ? forwarded[0] : forwarded;
              proxyReq.setHeader('cookie', cookieVal);
              proxyReq.removeHeader('x-forwarded-cookie');
            }
          });
          proxy.on('proxyRes', (_proxyRes: IncomingMessage, _req: IncomingMessage, res: ServerResponse) => {
            // Remove CORS restriction from upstream so browser accepts the response
            res.setHeader('Access-Control-Allow-Origin', '*');
          });
        },
      },
    },
  },
});
