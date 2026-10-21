import type { RequestHandler } from 'express';

// NoSQL injection: "$" bilan boshlanuvchi yoki "." li kalitlarni olib tashlaydi
function clean(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(clean);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key.startsWith('$') || key.includes('.')) delete obj[key];
      else clean(obj[key]);
    }
  }
}

export const sanitize: RequestHandler = (req, _res, next) => {
  clean(req.body);
  clean(req.query);
  clean(req.params);
  next();
};
