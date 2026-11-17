import { HydratedDocument, Schema, Types, model } from 'mongoose';
import {
  blocksField,
  sectionsField,
  SCORING_MODES,
  TIMING_MODES,
  type IExamBlock,
  type IExamSection,
  type ScoringMode,
  type TimingMode,
} from './ExamTemplate';

export const SESSION_TYPES = ['quiz', 'quarter', 'annual', 'trial', 'admission'] as const;
export type SessionType = (typeof SESSION_TYPES)[number];
/** draft -> (pending_approval ->) scheduled -> open -> closed; istalgan bosqichdan cancelled */
export const SESSION_STATUSES = [
  'draft',
  'pending_approval',
  'scheduled',
  'open',
  'closed',
  'cancelled',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const RESULTS_MODES = ['score', 'score_answers', 'after_publish', 'never'] as const;
export type ResultsMode = (typeof RESULTS_MODES)[number];
export const PARTICIPANT_KINDS = ['student', 'guest', 'candidate'] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

export interface ISessionParticipant {
  /** Sessiya ichida noyob tasodifiy kalit (E4 da urinish kaliti) */
  key: string;
  kind: ParticipantKind;
  refId: Types.ObjectId | null;
  fullName: string;
  className: string | null;
  grade: number | null;
  /** Mehmon: qayerdan kelgani */
  origin: string | null;
  /** sha256(pinSalt:PIN): kirishni tekshirish uchun. PIN ning o'zi HECH QACHON ochiq saqlanmaydi */
  pinHash: string;
  /** AES-256-GCM (EXAM_PIN_SECRET): faqat chop etish uchun, API ga chiqmaydi */
  pinEnc: string;
  /** To'liq davomiylik berilgan (kechikkan o'quvchi uchun): deadline = boshlagan vaqti + davomiylik */
  fullTimeGranted: boolean;
  extraMinutes: number;
  /** Nazoratchi boshqa qurilmadan qayta kirishga ruxsat berdi (bir martalik) */
  allowReentry: boolean;
  addedAt: Date;
}

/** Savolning to'liq nusxasi (javob kaliti bilan). Faqat serverda; admin DTO larida YO'Q */
export interface IPoolQuestion {
  questionId: Types.ObjectId;
  version: number;
  topicId: Types.ObjectId;
  subjectId: Types.ObjectId;
  type: string;
  difficulty: number;
  points: number;
  content: unknown[];
  options: unknown[];
  answer: unknown;
}

export interface IExamSession {
  schoolId: Types.ObjectId;
  templateId: Types.ObjectId | null;
  title: string;
  type: SessionType;
  subjectId: Types.ObjectId | null;
  classIds: Types.ObjectId[];
  academicYearId: Types.ObjectId;
  period: { periodId: Types.ObjectId; name: string; startDate: Date; endDate: Date } | null;
  /** Boshlanish vaqti (Toshkent +05:00 ma'nosida kiritilgan, Date sifatida saqlanadi) */
  scheduledStart: Date;
  /** per_block rejimida: bloklar davomiyliklari yig'indisi (server hisoblaydi) */
  durationMin: number;
  status: SessionStatus;
  /** 6 xonali kod: faqat scheduled/open da (codeActive) maktab ichida noyob */
  code: string | null;
  codeActive: boolean;
  sections: IExamSection[];
  /** Bloklar (bir nechta fanli imtihon). Eski hujjatlarda bo'sh: normalizator `sections` dan bitta blok yasaydi */
  blocks: IExamBlock[];
  scoringMode: ScoringMode;
  timingMode: TimingMode;
  /** Biriktirilgan o'qituvchilar savol topshirish muddati; o'tgach blok ularga faqat o'qish uchun */
  contribDeadline: Date | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  resultsMode: ResultsMode;
  /** O'tish bali (foiz, 1..100); null = belgilanmagan */
  passPercent: number | null;
  /** after_publish rejimida natijalar o'quvchilarga e'lon qilinganmi */
  resultsPublished: boolean;
  publishedAt: Date | null;
  supervisorIds: Types.ObjectId[];
  pinSalt: string;
  /** Noto'g'ri kod/PIN urinishlari (DB da: restartda yo'qolmaydi). alertAt: nazoratchiga ogohlantirish */
  joinFailures: { count: number; lastAt: Date | null; alertAt: Date | null };
  participants: ISessionParticipant[];
  questionPool: IPoolQuestion[];
  poolFrozenAt: Date | null;
  approval: {
    status: 'none' | 'pending' | 'approved' | 'rejected';
    by: Types.ObjectId | null;
    at: Date | null;
    reason: string;
  };
  openedAt: Date | null;
  closedAt: Date | null;
  cancelReason: string;
  createdBy: Types.ObjectId;
  isDeleted: boolean;
  /** "Faqat imtihonni o'chirish": imtihon yashirin, natijalar "Natijalar" bo'limida qoladi */
  resultsKept: boolean;
  /** Natijalar ko'chirma (snapshot): yopilganda saqlanadi, eski yopilganlarda yo'q (kod lazily hisoblaydi) */
  resultsMeta: unknown;
  /** "Tahrirlash uchun qaytarish" har safar +1: eslatma dedupe kalitiga kiradi (0: eski kalit formati) */
  scheduleVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
export type ExamSessionDoc = HydratedDocument<IExamSession>;

const participantSchema = new Schema<ISessionParticipant>(
  {
    key: { type: String, required: true },
    kind: { type: String, enum: PARTICIPANT_KINDS, required: true },
    refId: { type: Schema.Types.ObjectId, default: null },
    fullName: { type: String, required: true },
    className: { type: String, default: null },
    grade: { type: Number, default: null },
    origin: { type: String, default: null },
    pinHash: { type: String, required: true },
    pinEnc: { type: String, required: true },
    fullTimeGranted: { type: Boolean, default: false },
    extraMinutes: { type: Number, default: 0 },
    allowReentry: { type: Boolean, default: false },
    addedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const schema = new Schema<IExamSession>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'ExamTemplate', default: null },
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: SESSION_TYPES, required: true },
    subjectId: { type: Schema.Types.ObjectId, ref: 'Subject', default: null },
    classIds: { type: [Schema.Types.ObjectId], default: [] },
    academicYearId: { type: Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    period: { type: Schema.Types.Mixed, default: null },
    scheduledStart: { type: Date, required: true },
    durationMin: { type: Number, required: true },
    status: { type: String, enum: SESSION_STATUSES, default: 'draft' },
    code: { type: String, default: null },
    codeActive: { type: Boolean, default: false },
    sections: sectionsField,
    blocks: blocksField,
    scoringMode: { type: String, enum: SCORING_MODES, default: 'points' },
    timingMode: { type: String, enum: TIMING_MODES, default: 'common' },
    contribDeadline: { type: Date, default: null },
    shuffleQuestions: { type: Boolean, default: true },
    shuffleOptions: { type: Boolean, default: true },
    resultsMode: { type: String, enum: RESULTS_MODES, default: 'score' },
    passPercent: { type: Number, default: null },
    resultsPublished: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },
    supervisorIds: { type: [Schema.Types.ObjectId], default: [] },
    pinSalt: { type: String, required: true },
    joinFailures: {
      type: Schema.Types.Mixed,
      default: () => ({ count: 0, lastAt: null, alertAt: null }),
    },
    participants: { type: [participantSchema], default: [] },
    questionPool: { type: [Schema.Types.Mixed] as never, default: [], select: false },
    poolFrozenAt: { type: Date, default: null },
    approval: {
      type: Schema.Types.Mixed,
      default: () => ({ status: 'none', by: null, at: null, reason: '' }),
    },
    openedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDeleted: { type: Boolean, default: false },
    resultsKept: { type: Boolean, default: false },
    resultsMeta: { type: Schema.Types.Mixed, default: null },
    scheduleVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Natijalar ro'yxati (yopilgan imtihonlar, sana bo'yicha)
schema.index({ schoolId: 1, status: 1, scheduledStart: -1 });

// Kod: faqat faol (scheduled/open) sessiyalar orasida maktab ichida noyob. Kod qayta ishlatilishi mumkin.
// Partial indeks (codeActive:true): draft/yopilgan sessiyalar (code=null) indeksga kirmaydi.
// Bu indeks tavsifi keyin O'ZGARTIRILMAYDI (IndexOptionsConflict, BACKEND_XARITA 9.2).
schema.index(
  { schoolId: 1, code: 1 },
  { unique: true, partialFilterExpression: { codeActive: true }, name: 'unique_active_exam_code' },
);
// Kirishda kod bo'yicha qidirish (maktab noma'lum: PIN aniqlaydi). Mavjud indeksga tegilmaydi.
schema.index(
  { code: 1 },
  { partialFilterExpression: { codeActive: true }, name: 'active_exam_code_lookup' },
);
schema.index({ schoolId: 1, isDeleted: 1, status: 1, scheduledStart: -1 });
schema.index({ schoolId: 1, createdBy: 1 });
// Nomzodlarning oxirgi sessiyasini topish (PII tozalash)
schema.index({ schoolId: 1, 'participants.refId': 1 });

export const ExamSession = model<IExamSession>('ExamSession', schema);
