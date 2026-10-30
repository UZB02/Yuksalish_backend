import { Schema, Types, model } from 'mongoose';

export const BRANDING_OWNERS = ['platform', 'school'] as const;
export type BrandingOwner = (typeof BRANDING_OWNERS)[number];

export interface IBrandingAsset {
  ownerType: BrandingOwner;
  /** ownerType=platform bo'lsa null */
  schoolId: Types.ObjectId | null;
  /** logo | favicon | icon192 | icon512 | maskable512 | apple180 | doc */
  variant: string;
  data: Buffer;
  contentType: string;
  /** Asl logo mazmunining xeshi (barcha variantlarda bir xil — versiya uchun) */
  hash: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IBrandingAsset>(
  {
    ownerType: { type: String, enum: BRANDING_OWNERS, required: true },
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', default: null },
    variant: { type: String, required: true },
    data: { type: Buffer, required: true, select: false },
    contentType: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: true },
);

schema.index({ ownerType: 1, schoolId: 1, variant: 1 }, { unique: true });

export const BrandingAsset = model<IBrandingAsset>('BrandingAsset', schema);
