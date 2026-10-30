import type { Request, Response } from 'express';
import type { IBrandingAsset } from '../../models/BrandingAsset';

/** Logo PNG ni berish: ETag, versiyalangan so'rovga immutable kesh, aks holda qisqa kesh */
export function sendLogo(
  req: Request,
  res: Response,
  asset: Pick<IBrandingAsset, 'data' | 'contentType' | 'hash'>,
  immutable: boolean,
) {
  const etag = `"${asset.hash}-${asset.data.length}"`;
  res.set({
    'Content-Type': asset.contentType,
    ETag: etag,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.set('Content-Length', String(asset.data.length));
  res.status(200).end(asset.data);
}
