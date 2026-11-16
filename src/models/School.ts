import { HydratedDocument, Schema, model } from 'mongoose';

export interface ISchool {
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  logoUrl: string | null;
  /** Yuklangan logo xeshi (BrandingAsset); null = yuklanmagan */
  logoHash: string | null;
  isActive: boolean;
  /** Butunlay o'chirish boshlangan vaqt (null = oddiy maktab). Qo'yilsa maktab "yo'q" hisoblanadi */
  deletingAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type SchoolDoc = HydratedDocument<ISchool>;

const schoolSchema = new Schema<ISchool>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    address: { type: String, trim: true, default: null },
    phone: { type: String, trim: true, default: null },
    logoUrl: { type: String, trim: true, default: null },
    logoHash: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    deletingAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const School = model<ISchool>('School', schoolSchema);
