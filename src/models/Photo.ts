import { HydratedDocument, Schema, Types, model } from 'mongoose';

export const PHOTO_OWNER_TYPES = ['student', 'user'] as const;
export type PhotoOwnerType = (typeof PHOTO_OWNER_TYPES)[number];

export interface IPhoto {
  schoolId: Types.ObjectId;
  ownerType: PhotoOwnerType;
  ownerId: Types.ObjectId;
  /** Qayta kodlangan WebP (EXIF/GPS yo'q) */
  data: Buffer;
  contentType: string;
  width: number;
  height: number;
  size: number;
  /** Mazmun xeshi (ETag uchun) */
  hash: string;
  createdAt: Date;
  updatedAt: Date;
}
export type PhotoDoc = HydratedDocument<IPhoto>;

const photoSchema = new Schema<IPhoto>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    ownerType: { type: String, enum: PHOTO_OWNER_TYPES, required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    // Ro'yxat so'rovlarida binar ma'lumot tasodifan yuklanmasligi uchun
    data: { type: Buffer, required: true, select: false },
    contentType: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    size: { type: Number, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: true },
);

// Bir egada bitta rasm (almashtirishda yangi _id bilan yoziladi, eskisi o'chiriladi)
photoSchema.index({ ownerType: 1, ownerId: 1 });
photoSchema.index({ schoolId: 1 });

export const Photo = model<IPhoto>('Photo', photoSchema);
