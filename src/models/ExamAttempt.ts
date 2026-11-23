import { HydratedDocument, Schema, Types, model } from 'mongoose';

/**
 * Ishtirokchining imtihon urinishi (E4). Bitta {sessionId, participantKey} ga bitta hujjat.
 *  - joined: PIN bilan kirildi (token berildi), hali boshlanmagan;
 *  - in_progress: boshlandi (deadline server tomonda hisoblangan);
 *  - submitted / auto_submitted: topshirildi / vaqt tugashi bilan avtomatik topshirildi.
 * Savol nusxalari sessiyada qoladi; bu yerda faqat tartib (`order`), javoblar va hodisalar.
 * Hamma holat DB da (xotirada hech narsa): server qayta ishga tushsa ham deadline va javoblar saqlanadi.
 */
export const ATTEMPT_STATUSES = ['joined', 'in_progress', 'submitted', 'auto_submitted'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const EVENT_TYPES = ['blur', 'fullscreen_exit', 'visibility_hidden', 'reconnect'] as const;
export type AttemptEventType = (typeof EVENT_TYPES)[number];
/** Serverda yoziladigan hodisalar (nazoratchi amallari): mijoz yubora olmaydi (EVENT_TYPES dan alohida) */
export const SERVER_EVENT_TYPES = ['warning_sent', 'warning_ack', 'terminated'] as const;
export type AttemptServerEventType = (typeof SERVER_EVENT_TYPES)[number];
export const MAX_EVENTS = 200;
/** Bitta urinishda saqlanadigan nazoratchi ogohlantirishlari soni (eskilari tushadi) */
export const MAX_WARNINGS = 50;

export interface IAttemptOrderItem {
  /** Blok id (eski urinishlarda yo'q: birinchi/yagona blok) */
  blockId?: string;
  /** Savol id (satr): sessiya savollar nusxasidagi questionId */
  qid: string;
  type: string;
  points: number;
  /** Variantlar tartibi (variant id lari); shuffleOptions bo'lmasa asl tartib */
  optionPerm: string[];
}

export interface ISavedAnswer {
  qid: string;
  /** single: optionId, multi: optionId[], short/essay: matn; bo'sh = tozalangan */
  value: unknown;
  flagged: boolean;
  answered: boolean;
  at: Date;
}

export interface IAttemptEvent {
  type: AttemptEventType | AttemptServerEventType;
  /** Klient vaqti (ishonchsiz, faqat ma'lumot uchun) */
  at: Date | null;
  serverAt: Date;
}

/** Nazoratchi ogohlantirishi: o'quvchi ekranida chiqadi, tasdiqlagach `ackAt` qo'yiladi */
export interface IAttemptWarning {
  id: string;
  /** Oddiy matn (<=200 belgi) */
  text: string;
  at: Date;
  by: string;
  byName: string;
  ackAt: Date | null;
}

/** Nazoratchi imtihonni to'xtatgan: urinish `submitted` bo'ladi (shu paytgacha javoblar baholangan), bu belgi qo'shiladi */
export interface IAttemptTerminated {
  at: Date;
  by: string;
  byName: string;
  reason: string;
}

/** Esse uchun qo'lda qo'yilgan ball (E6) */
export interface IManualGrade {
  qid: string;
  points: number;
  comment: string;
  gradedBy: string;
  gradedAt: Date;
}

export interface IAttemptBlockScore {
  blockId: string;
  earned: number;
  max: number;
  autoMax: number;
  essayPending: number;
  /** Blokdagi savollar soni va to'g'ri (to'liq ball) javoblar soni */
  questions: number;
  correct: number;
}

/** per_block: har bir blokning holati (urinishda saqlanadi; deadline lar server tomonda) */
export interface IAttemptBlockState {
  blockId: string;
  durationMin: number;
  startedAt: Date | null;
  deadline: Date | null;
  /** Hammaga vaqt qo'shish (extend) shu blokka qo'shgan daqiqalar */
  extraMin: number;
  closedAt: Date | null;
}

export interface IAttemptScore {
  earned: number;
  max: number;
  /** Faqat avtomatik tekshiriladigan savollarning maksimumi */
  autoMax: number;
  essayPending: number;
  items: { qid: string; got: number; max: number; ok: boolean | null; graded?: boolean }[];
  /** Blok bo'yicha ballar (eski natijalarda yo'q: yagona blok deb o'qiladi) */
  blocks?: IAttemptBlockScore[];
}

export interface IExamAttempt {
  schoolId: Types.ObjectId;
  sessionId: Types.ObjectId;
  participantKey: string;
  participantKind: 'student' | 'guest' | 'candidate';
  fullName: string;
  className: string | null;
  /** sha256(token): token o'zi saqlanmaydi */
  tokenHash: string;
  tokenExpiresAt: Date;
  deviceId: string;
  status: AttemptStatus;
  startedAt: Date | null;
  deadline: Date | null;
  submittedAt: Date | null;
  order: IAttemptOrderItem[];
  /** Rasm id lari (savol va variantlarda): token orqali faqat shularni olish mumkin */
  assetIds: string[];
  saved: ISavedAnswer[];
  clientSeq: number;
  answeredCount: number;
  /** per_block: joriy blok indeksi, har blok holati va qattiq (umumiy) deadline. Eski urinishlarda bo'sh */
  blockIndex: number;
  blockState: IAttemptBlockState[];
  hardDeadline: Date | null;
  events: IAttemptEvent[];
  counters: { blur: number; fullscreenExit: number; visibilityHidden: number; reconnect: number };
  lastSeenAt: Date | null;
  /** Oxirgi oynadan chiqish (blur / visibility_hidden / fullscreen_exit) serverda yozilgan vaqt; eski urinishlarda yo'q */
  lastLeaveAt: Date | null;
  /** Nazoratchi ogohlantirishlari (eng ko'pi MAX_WARNINGS) va oxirgisi yuborilgan vaqt (tezlik cheklovi uchun) */
  warnings: IAttemptWarning[];
  lastWarnAt: Date | null;
  /** Nazoratchi to'xtatgan bo'lsa; aks holda null. Eski urinishlarda yo'q (= null) */
  terminated: IAttemptTerminated | null;
  /** Esse baholari (massiv; qid bo'yicha bitta) */
  manual: IManualGrade[];
  score: IAttemptScore | null;
  scoredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type ExamAttemptDoc = HydratedDocument<IExamAttempt>;

const schema = new Schema<IExamAttempt>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'ExamSession', required: true },
    participantKey: { type: String, required: true },
    participantKind: { type: String, required: true },
    fullName: { type: String, required: true },
    className: { type: String, default: null },
    tokenHash: { type: String, required: true },
    tokenExpiresAt: { type: Date, required: true },
    deviceId: { type: String, required: true },
    status: { type: String, enum: ATTEMPT_STATUSES, default: 'joined' },
    startedAt: { type: Date, default: null },
    deadline: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    order: { type: [Schema.Types.Mixed] as never, default: [] },
    assetIds: { type: [String], default: [] },
    saved: { type: [Schema.Types.Mixed] as never, default: [] },
    clientSeq: { type: Number, default: 0 },
    blockIndex: { type: Number, default: 0 },
    blockState: { type: [Schema.Types.Mixed] as never, default: [] },
    hardDeadline: { type: Date, default: null },
    answeredCount: { type: Number, default: 0 },
    events: { type: [Schema.Types.Mixed] as never, default: [] },
    counters: {
      type: Schema.Types.Mixed,
      default: () => ({ blur: 0, fullscreenExit: 0, visibilityHidden: 0, reconnect: 0 }),
    },
    lastSeenAt: { type: Date, default: null },
    lastLeaveAt: { type: Date, default: null },
    warnings: { type: [Schema.Types.Mixed] as never, default: [] },
    lastWarnAt: { type: Date, default: null },
    terminated: { type: Schema.Types.Mixed, default: null },
    manual: { type: [Schema.Types.Mixed] as never, default: [] },
    score: { type: Schema.Types.Mixed, default: null },
    scoredAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Bir ishtirokchiga bitta urinish (start/join idempotent)
schema.index({ sessionId: 1, participantKey: 1 }, { unique: true });
// Token bo'yicha autentifikatsiya (har so'rov)
schema.index({ tokenHash: 1 }, { unique: true });
// Sweeper: muddati o'tgan in_progress urinishlar
schema.index({ status: 1, deadline: 1 });
schema.index({ schoolId: 1, sessionId: 1 });
// Sweeper: bahosiz avtomatik topshirilganlar (kichik qisman indeks; boshqa hujjatlar indeksga kirmaydi)
schema.index(
  { status: 1, sessionId: 1 },
  { partialFilterExpression: { score: null }, name: 'attempts_unscored' },
);

export const ExamAttempt = model<IExamAttempt>('ExamAttempt', schema);
