import { Types } from 'mongoose';
import { AppError } from '../../../core/errors';
import { ExamFile } from '../../../models/ExamFile';
import type { ExamSessionDoc } from '../../../models/ExamSession';
import { normalizeBlocks, type NBlock } from '../blocks/blocks.core';
import { validateFileTest } from './filetest.core';

const oid = (s: string) => new Types.ObjectId(s);

/** Fayllar shu imtihonning shu blokiga tegishli yozuvlar ekanini tekshiradi (boshqa maktab/imtihon/blok fayli mumkin emas) */
export async function assertFilesExist(
  schoolId: string,
  sessionId: string,
  blockId: string,
  ids: string[],
) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return;
  const n = await ExamFile.countDocuments({
    schoolId,
    sessionId,
    blockId,
    _id: { $in: uniq.map(oid) },
  });
  if (n !== uniq.length) {
    throw AppError.validation('Fayl topilmadi', [
      { path: 'fileTest', message: 'Ba‘zi fayllar topilmadi: qayta yuklang' },
    ]);
  }
}

/**
 * Rejalashtirish/"tayyor" uchun to'liq tekshiruv (faqat faol rejim `file`): har variantda kalit (ekranda: fayl ham),
 * savollar va ballar teng; ekranda fayllar diskda bo'lishi (muddati o'tmagan) shart.
 */
export async function assertFileBlockReady(schoolId: string, sessionId: string, b: NBlock) {
  if (b.content !== 'file') return;
  const issues = validateFileTest(b.fileTest, true);
  if (issues.length) {
    throw AppError.validation(
      `${b.title || 'Fan'}: fayl testi to'liq emas`,
      issues.map((i) => ({ path: 'fileTest', message: `${b.title || 'Fan'}: ${i.message}` })),
    );
  }
  if (b.fileTest!.delivery !== 'screen') return;
  const ids = b.fileTest!.variants.flatMap((v) => v.files);
  await assertFilesExist(schoolId, sessionId, b.blockId, ids);
  const notReady = await ExamFile.countDocuments({
    _id: { $in: ids.map(oid) },
    state: { $ne: 'ready' },
  });
  if (notReady) {
    throw AppError.validation(`${b.title || 'Fan'}: test fayli muddati tugagan`, [
      {
        path: 'fileTest',
        message: `${b.title || 'Fan'}: test fayli muddati tugagan yoki yuklanmagan: faylni qayta yuklang`,
      },
    ]);
  }
}

/** Sessiyadagi barcha fayl bloklarini tekshiradi (rejalashtirishdan oldin) */
export async function assertFileBlocksReady(schoolId: string, s: ExamSessionDoc) {
  for (const b of normalizeBlocks(s)) await assertFileBlockReady(schoolId, String(s._id), b);
}

/** Faol fayl+ekran bloklaridagi muddati tugagan fayllar (qayta ochishdan oldin tekshiriladi) */
export async function expiredFilesOf(s: ExamSessionDoc): Promise<string[]> {
  const ids: string[] = [];
  for (const b of normalizeBlocks(s)) {
    if (b.content === 'file' && b.fileTest?.delivery === 'screen') {
      ids.push(...b.fileTest.variants.flatMap((v) => v.files));
    }
  }
  if (!ids.length) return [];
  const bad = await ExamFile.find({ _id: { $in: ids.map(oid) }, state: { $ne: 'ready' } })
    .select('_id')
    .lean();
  return bad.map((x) => String(x._id));
}
