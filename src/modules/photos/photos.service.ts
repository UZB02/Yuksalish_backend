import { Types } from 'mongoose';
import type { Ctx } from '../../core/context';
import { AppError } from '../../core/errors';
import { Photo, type PhotoOwnerType } from '../../models/Photo';
import { auditService } from '../audit/audit.service';
import { publicCache } from '../public/public.cache';
import { processPhoto } from './photos.process';

/** Rasm biriktiriladigan hujjat (Student yoki User) */
interface Owner {
  id: string;
  photoId: Types.ObjectId | null;
  save(): Promise<unknown>;
}

interface Target {
  schoolId: string;
  ownerType: PhotoOwnerType;
  owner: Owner;
  /** Audit: masalan 'student' -> student.photo_upload */
  auditPrefix: string;
  auditEntity: 'student' | 'user';
}

export const photosService = {
  /** Yuklash yoki almashtirish: yangi Photo yoziladi (yangi _id -> yangi havola), eskisi o'chadi */
  async set(ctx: Ctx, t: Target, file: Express.Multer.File | undefined) {
    if (!file) {
      throw AppError.validation('Rasm yuklanmagan', [
        { path: 'photo', message: "'photo' maydoni majburiy" },
      ]);
    }
    const p = await processPhoto(file.buffer);
    const doc = await Photo.create({
      schoolId: t.schoolId,
      ownerType: t.ownerType,
      ownerId: t.owner.id,
      data: p.data,
      contentType: p.contentType,
      width: p.width,
      height: p.height,
      size: p.size,
      hash: p.hash,
    });
    const previous = t.owner.photoId;
    t.owner.photoId = doc._id;
    await t.owner.save();
    await Photo.deleteMany({ ownerType: t.ownerType, ownerId: t.owner.id, _id: { $ne: doc._id } });
    publicCache.clear();
    await auditService.log({
      userId: ctx.actor.id,
      schoolId: t.schoolId,
      action: `${t.auditPrefix}.photo_upload`,
      entity: t.auditEntity,
      entityId: t.owner.id,
      before: { photoId: previous ? String(previous) : null },
      after: { photoId: doc.id, size: p.size, width: p.width, height: p.height },
      ip: ctx.ip,
    });
  },

  /** Rasmni o'chirish (rasm bo'lmasa ham xato emas) */
  async clear(ctx: Ctx, t: Target) {
    const previous = t.owner.photoId;
    await Photo.deleteMany({ ownerType: t.ownerType, ownerId: t.owner.id });
    if (previous) {
      t.owner.photoId = null;
      await t.owner.save();
    }
    publicCache.clear();
    if (previous) {
      await auditService.log({
        userId: ctx.actor.id,
        schoolId: t.schoolId,
        action: `${t.auditPrefix}.photo_delete`,
        entity: t.auditEntity,
        entityId: t.owner.id,
        before: { photoId: String(previous) },
        ip: ctx.ip,
      });
    }
  },

  /** Ega o'chirilganda (o'quvchi soft-delete) rasm ham o'chadi — bolalar maxfiyligi */
  async purgeOwner(ownerType: PhotoOwnerType, ownerId: string) {
    await Photo.deleteMany({ ownerType, ownerId });
    publicCache.clear();
  },
};
