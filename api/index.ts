import express from 'express';
import cookieParser from 'cookie-parser';
import { serverConfig } from '../server/config.ts';
import { registerApiRoutes } from '../server/routes.ts';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(serverConfig.sessionSecret));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

registerApiRoutes(app);

export default app;
