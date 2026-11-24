import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { serverConfig } from './server/config.ts';
import { registerApiRoutes } from './server/routes.ts';
import { derivPublic } from './server/derivClient.ts';

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(serverConfig.sessionSecret));

  // Basic security headers (avoid X-Frame-Options to preserve AI Studio iFrame embedding)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  registerApiRoutes(app);

  const distDir = path.resolve(process.cwd(), 'dist');
  const hasDist = fs.existsSync(path.join(distDir, 'index.html'));

  if (!serverConfig.isProduction && !process.env.SERVE_STATIC_ONLY) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (hasDist) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(serverConfig.port, '0.0.0.0', () => {
    console.log(`DQI server listening on http://0.0.0.0:${serverConfig.port}`);
  });

  const shutdown = () => {
    derivPublic.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start DQI server:', err);
  process.exit(1);
});
