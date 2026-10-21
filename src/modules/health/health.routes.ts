import { Router } from 'express';
import { isDbConnected } from '../../config/db';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const db = isDbConnected();
  if (!db) {
    return res.status(503).json({
      success: false,
      error: { code: 'INTERNAL', message: "Ma'lumotlar bazasi bilan aloqa yo'q" },
    });
  }
  res.json({
    success: true,
    data: { status: 'ok', db: 'connected', uptime: Math.round(process.uptime()) },
  });
});
