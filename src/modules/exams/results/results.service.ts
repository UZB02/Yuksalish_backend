import { z } from 'zod';
import type { Ctx } from '../../../core/context';
import { AppError } from '../../../core/errors';
import { ExamAttempt } from '../../../models/ExamAttempt';
import { ExamSession, type ExamSessionDoc } from '../../../models/ExamSession';
import { School } from '../../../models/School';
import { User } from '../../../models/User';
import { clock } from '../../../utils/clock';
import { gradeAttempt } from '../../exam-client/grading';
import type { PoolQuestion } from '../../exam-client/selection';
import { renderExcel, safeText } from '../../reports/reports.excel';
import type { ReportLayout, Table } from '../../reports/reports.layout';
import { renderPdf } from '../../reports/reports.pdf';
import { contentDisposition, contentTypeOf, safeFileName } from '../../reports/reports.files';
import { resolveExamScope, type ExamScope } from '../exams.scope';
import { fmtTashkent } from '../sessions/sessions.pdf';
import { audit, findSession, isCreator, isSupervisor } from '../sessions/sessions.service';
import { commonEnd } from '../sessions/timing';
import { buildRows, loadAttempts, poolMapOf, sortRanked, type ResultRow } from './results.core';

type Actor = Ctx['actor'];

export const gradeBody = z
  .object({
    points: z
      .number()
      .min(0)
      .max(1000)
      .refine(
        (v) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9,
        'Ball 0.5 qadam bilan bo‘lishi kerak',
      ),
    comment: z.string().trim().max(1000).default(''),
  })
  .strict();
export const publishBody = z
  .object({ published: z.boolean(), confirmPending: z.boolean().optional() })
  .strict();
export const exportQuery = z.object({ format: z.enum(['xlsx', 'pdf']).default('xlsx') });

const STATUS_UZ: Record<string, string> = {
  not_started: 'Kirmagan',
  joined: 'Kirgan',
  in_progress: 'Yechyapti',
  submitted: 'Topshirgan',
  auto_submitted: 'Avtomatik topshirilgan',
};

const hasPerm = (actor: Actor, ...p: string[]) =>
  actor.role === 'superadmin' || p.some((x) => actor.permissions.includes(x));

/**
 * Ruxsat: imtihon yaratuvchisi va nazoratchilari har doim; ma'muriyat `exams.results` (yoki exams.manage) bilan.
 * O'qituvchi boshqa o'qituvchining imtihonini ko'rmaydi (findSession 404). Esse baholash: `exams.grade`/exams.manage
 * yoki yaratuvchi/nazoratchi.
 */
async function open(ctx: Ctx, schoolId: string, id: string, grade = false) {
  const scope = await resolveExamScope(ctx.actor, schoolId);
  const s0 = await findSession(ctx, schoolId, scope, id);
  const own = isCreator(s0, ctx.actor) || isSupervisor(s0, ctx.actor);
  if (!own && !hasPerm(ctx.actor, 'exams.results', 'exams.manage')) throw AppError.forbidden();
  if (grade && !own && !hasPerm(ctx.actor, 'exams.grade', 'exams.manage'))
    throw AppError.forbidden();
  if (!['open', 'closed'].includes(s0.status)) {
    throw AppError.conflict('Natijalar imtihon boshlangandan keyin mavjud bo‘ladi');
  }
  const s = (await ExamSession.findById(s0._id).select('+questionPool'))!;
  return { s, scope, own };
}

const blocksOf = (list: unknown[] | undefined) =>
  (list ?? []).map((b) => {
    const x = b as { type?: string; text?: string; tex?: string; assetId?: unknown };
    if (x.type === 'math') return { type: 'math' as const, tex: String(x.tex ?? '') };
    if (x.type === 'image') return { type: 'image' as const, assetId: String(x.assetId) };
    return { type: 'text' as const, text: String(x.text ?? '') };
  });

const nameOf = async (ids: string[]) => {
  const users = await User.find({ _id: { $in: ids } })
    .select('fullName')
    .lean();
  return new Map(users.map((u) => [String(u._id), u.fullName]));
};

function passInfo(s: ExamSessionDoc) {
  return { passPercent: s.passPercent ?? null };
}

export const resultsService = {
  /** Natijalar ro'yxati va umumiy ko'rsatkichlar */
  async list(ctx: Ctx, schoolId: string, id: string) {
    const { s } = await open(ctx, schoolId, id);
    const attempts = await loadAttempts(s);
    const { rows, summary } = buildRows(s, attempts);
    return {
      session: {
        id: s.id as string,
        title: s.title,
        status: s.status,
        resultsMode: s.resultsMode,
        resultsPublished: s.resultsPublished,
        publishedAt: s.publishedAt,
        ...passInfo(s),
        scheduledStart: s.scheduledStart,
        endsAt: commonEnd(s),
      },
      summary,
      rows: sortRanked(rows),
    };
  },

  /** Ishtirokchi tafsiloti: har savol bo'yicha javob, to'g'ri javob, ball; esse matni (oddiy matn) */
  async detail(ctx: Ctx, schoolId: string, id: string, key: string) {
    const { s } = await open(ctx, schoolId, id);
    const p = s.participants.find((x) => x.key === key);
    if (!p) throw AppError.notFound('Ishtirokchi topilmadi');
    const a = await ExamAttempt.findOne({ sessionId: s._id, participantKey: key, schoolId });
    if (!a) {
      return {
        participant: { key, fullName: p.fullName, className: p.className ?? p.origin },
        status: 'not_started',
        questions: [],
        score: null,
      };
    }
    const pool = poolMapOf(s);
    if (['submitted', 'auto_submitted'].includes(a.status) && !a.score) {
      a.score = gradeAttempt(a.order, a.saved, pool, a.manual ?? []);
    }
    const saved = new Map(a.saved.map((x) => [x.qid, x]));
    const manual = new Map((a.manual ?? []).map((m) => [m.qid, m]));
    const graders = await nameOf([...new Set((a.manual ?? []).map((m) => m.gradedBy))]);
    const items = new Map((a.score?.items ?? []).map((i) => [i.qid, i]));
    const questions = a.order.map((o, index) => {
      const q = pool.get(o.qid) as PoolQuestion | undefined;
      const key2 = (q?.answer ?? {}) as Record<string, unknown>;
      const optById = new Map((q?.options ?? []).map((x) => [x.id, x]));
      const sv = saved.get(o.qid);
      const m = manual.get(o.qid);
      const it = items.get(o.qid);
      return {
        id: o.qid,
        index: index + 1,
        type: o.type,
        points: o.points,
        content: blocksOf(q?.content),
        options: o.optionPerm.map((oid) => ({
          id: oid,
          content: blocksOf(optById.get(oid)?.content),
        })),
        given: sv?.value ?? null,
        flagged: !!sv?.flagged,
        correct:
          o.type === 'single'
            ? { optionIds: key2.optionId ? [String(key2.optionId)] : [] }
            : o.type === 'multi'
              ? { optionIds: ((key2.optionIds as string[]) ?? []).map(String) }
              : o.type === 'short'
                ? { texts: ((key2.acceptedAnswers as string[]) ?? []).map(String) }
                : { rubric: String(key2.rubric ?? '') },
        got: it?.got ?? null,
        ok: it?.ok ?? null,
        graded: o.type === 'essay' ? !!m : null,
        grade: m
          ? {
              points: m.points,
              comment: m.comment,
              by: graders.get(m.gradedBy) ?? null,
              at: m.gradedAt,
            }
          : null,
      };
    });
    const { rows } = buildRows(s, [a]);
    return {
      participant: { key, fullName: p.fullName, className: p.className ?? p.origin, kind: p.kind },
      status: a.status,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
      score: a.score
        ? { earned: a.score.earned, max: a.score.max, essayPending: a.score.essayPending }
        : null,
      percent: rows[0]?.percent ?? null,
      questions,
    };
  },

  /** Esse ball qo'yish (0..max, qadam 0.5): umumiy ball qayta hisoblanadi */
  async gradeEssay(
    ctx: Ctx,
    schoolId: string,
    id: string,
    key: string,
    qid: string,
    body: z.output<typeof gradeBody>,
  ) {
    const { s } = await open(ctx, schoolId, id, true);
    const a = await ExamAttempt.findOne({ sessionId: s._id, participantKey: key, schoolId });
    if (!a) throw AppError.notFound('Urinish topilmadi');
    if (!['submitted', 'auto_submitted'].includes(a.status)) {
      throw AppError.conflict('Esse faqat topshirilgan ishda baholanadi');
    }
    const o = a.order.find((x) => x.qid === qid);
    if (!o || o.type !== 'essay') throw AppError.notFound('Esse savol topilmadi');
    if (body.points > o.points) {
      throw AppError.validation('Ball maksimaldan oshmasligi kerak', [
        { path: 'points', message: `0 dan ${o.points} gacha` },
      ]);
    }
    const entry = {
      qid,
      points: body.points,
      comment: body.comment,
      gradedBy: ctx.actor.id,
      gradedAt: clock.now(),
    };
    const before = (a.manual ?? []).find((m) => m.qid === qid)?.points ?? null;
    await ExamAttempt.updateOne(
      { _id: a._id },
      [
        {
          $set: {
            manual: {
              $concatArrays: [
                {
                  $filter: {
                    input: { $ifNull: ['$manual', []] },
                    as: 'm',
                    cond: { $ne: ['$$m.qid', qid] },
                  },
                },
                { $literal: [entry] },
              ],
            },
          },
        },
      ],
      { updatePipeline: true },
    );
    const fresh = (await ExamAttempt.findById(a._id))!;
    const score = gradeAttempt(fresh.order, fresh.saved, poolMapOf(s), fresh.manual ?? []);
    await ExamAttempt.updateOne({ _id: a._id }, { $set: { score, scoredAt: clock.now() } });
    // Audit: faqat xulosa (esse matni yozilmaydi)
    await audit(
      ctx,
      schoolId,
      'exam.attempt.grade',
      s.id,
      { points: before },
      { points: body.points, max: o.points, earned: score.earned, pending: score.essayPending },
    );
    return { earned: score.earned, max: score.max, essayPending: score.essayPending };
  },

  /** after_publish rejimida natijalarni o'quvchilarga e'lon qilish / qaytarib olish */
  async publish(ctx: Ctx, schoolId: string, id: string, body: z.output<typeof publishBody>) {
    const { s } = await open(ctx, schoolId, id, true);
    if (s.resultsMode !== 'after_publish') {
      throw AppError.conflict('Bu imtihon natijasi e‘lon qilishni talab qilmaydi');
    }
    if (body.published) {
      const attempts = await loadAttempts(s);
      const { summary } = buildRows(s, attempts);
      if (summary.essayPending > 0 && !body.confirmPending) {
        throw AppError.conflict(`${summary.essayPending} ta esse hali tekshirilmagan`, [
          { path: 'essayPending', message: String(summary.essayPending) },
        ]);
      }
    }
    s.resultsPublished = body.published;
    s.publishedAt = body.published ? clock.now() : null;
    await s.save();
    await audit(ctx, schoolId, 'exam.session.publish', s.id, null, { published: body.published });
    return { published: s.resultsPublished, publishedAt: s.publishedAt };
  },

  /** Savollar tahlili (muzlatilgan savollar nusxasi bo'yicha) */
  async analysis(ctx: Ctx, schoolId: string, id: string) {
    const { s } = await open(ctx, schoolId, id);
    const attempts = (await loadAttempts(s)).filter((a) =>
      ['submitted', 'auto_submitted'].includes(a.status),
    );
    const pool = poolMapOf(s);
    const stats = new Map<
      string,
      {
        shown: number;
        answered: number;
        correct: number;
        gotSum: number;
        graded: number;
        dist: Map<string, number>;
      }
    >();
    for (const a of attempts) {
      const saved = new Map(a.saved.map((x) => [x.qid, x.value]));
      const items = new Map((a.score?.items ?? []).map((i) => [i.qid, i]));
      for (const o of a.order) {
        const st = stats.get(o.qid) ?? {
          shown: 0,
          answered: 0,
          correct: 0,
          gotSum: 0,
          graded: 0,
          dist: new Map(),
        };
        st.shown++;
        const v = saved.get(o.qid);
        const it = items.get(o.qid);
        if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
          st.answered++;
        if (it?.ok === true) st.correct++;
        if (it && it.ok !== null) {
          st.gotSum += it.got;
          st.graded++;
        } else if (it?.graded) {
          st.gotSum += it.got;
          st.graded++;
        }
        if (o.type === 'single' || o.type === 'multi') {
          for (const oid of Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []) {
            st.dist.set(oid, (st.dist.get(oid) ?? 0) + 1);
          }
        }
        stats.set(o.qid, st);
      }
    }
    const questions = [...pool.values()].map((q, i) => {
      const qid = String(q.questionId);
      const st = stats.get(qid);
      const key = (q.answer ?? {}) as Record<string, unknown>;
      const correctIds = new Set<string>(
        q.type === 'single'
          ? key.optionId
            ? [String(key.optionId)]
            : []
          : q.type === 'multi'
            ? ((key.optionIds as string[]) ?? []).map(String)
            : [],
      );
      const shown = st?.shown ?? 0;
      const correctPercent =
        shown && q.type !== 'essay' ? Math.round((st!.correct / shown) * 1000) / 10 : null;
      const options = (q.options ?? []).map((o) => {
        const chosen = st?.dist.get(o.id) ?? 0;
        return {
          id: o.id,
          content: blocksOf(o.content),
          chosen,
          percent: shown ? Math.round((chosen / shown) * 1000) / 10 : 0,
          correct: correctIds.has(o.id),
        };
      });
      const flags: string[] = [];
      if (shown >= 3 && correctPercent !== null) {
        if (correctPercent > 90) flags.push('too_easy');
        if (correctPercent < 20) flags.push('too_hard');
      }
      if (shown >= 3 && (q.type === 'single' || q.type === 'multi')) {
        const topCorrect = Math.max(0, ...options.filter((o) => o.correct).map((o) => o.chosen));
        if (options.some((o) => !o.correct && o.percent >= 40 && o.chosen >= topCorrect))
          flags.push('distractor');
      }
      return {
        id: qid,
        index: i + 1,
        type: q.type,
        points: q.points,
        content: blocksOf(q.content),
        shown,
        answered: st?.answered ?? 0,
        correctPercent,
        averagePoints: st && st.graded ? Math.round((st.gotSum / st.graded) * 100) / 100 : null,
        options,
        flags,
      };
    });
    return { submittedAttempts: attempts.length, questions };
  },

  /** Excel (ishtirokchilar + savollar matritsasi + savollar) yoki PDF xulosa. Telefon/PII yo'q, formula injeksiyasidan himoya */
  async export(ctx: Ctx, schoolId: string, id: string, format: 'xlsx' | 'pdf') {
    const { s } = await open(ctx, schoolId, id);
    const attempts = await loadAttempts(s);
    const { rows, summary } = buildRows(s, attempts);
    const ranked = sortRanked(rows);
    const school = await School.findById(schoolId).select('name').lean();
    const pool = poolMapOf(s);
    const date = fmtTashkent(s.scheduledStart).slice(0, 10);
    const dayIso = s.scheduledStart.toISOString().slice(0, 10);
    const meta = {
      generatedAt: clock.now().toISOString(),
      period: { from: dayIso, to: dayIso },
      school: school ? { id: schoolId, name: school.name } : null,
      scope: 'exam',
    };
    const fmtMin = (sec: number | null) =>
      sec === null ? '' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const main: Table = {
      title: 'Natijalar',
      columns: [
        { header: "O'rin", key: 'rank', width: 7, type: 'int', align: 'center' },
        { header: 'F.I.Sh.', key: 'name', width: 32 },
        { header: 'Sinf / manba', key: 'cls', width: 16 },
        { header: 'Holat', key: 'status', width: 20 },
        { header: 'Ball', key: 'earned', width: 8, type: 'number', align: 'right' },
        { header: 'Maks.', key: 'max', width: 8, type: 'number', align: 'right' },
        { header: '%', key: 'percent', width: 8, type: 'number', align: 'right' },
        { header: "O'tdi", key: 'passed', width: 8, align: 'center' },
        { header: 'Javoblar', key: 'answered', width: 10, align: 'center' },
        { header: 'Vaqt (daq:son)', key: 'time', width: 12, align: 'center', short: 'Vaqt' },
        {
          header: 'Ogohlantirish',
          key: 'warn',
          width: 12,
          type: 'int',
          align: 'center',
          short: 'Ogoh.',
        },
        {
          header: 'Esse kutilmoqda',
          key: 'essay',
          width: 12,
          type: 'int',
          align: 'center',
          short: 'Esse',
        },
      ],
      rows: ranked.map((r: ResultRow) => ({
        rank: r.rank,
        name: r.fullName,
        cls: r.className ?? '',
        status: STATUS_UZ[r.status] ?? r.status,
        earned: r.earned,
        max: r.max,
        percent: r.percent,
        passed: r.passed === null ? '' : r.passed ? 'Ha' : "Yo'q",
        answered: r.total ? `${r.answered}/${r.total}` : '',
        time: fmtMin(r.timeSpentSec),
        warn: r.warnings,
        essay: r.essayPending,
      })),
    };
    const kpis = [
      { label: 'Imtihon', value: s.title },
      { label: 'Sana', value: date },
      { label: 'Ishtirokchilar', value: summary.participants },
      { label: 'Topshirgan', value: summary.submitted },
      { label: "O'rtacha %", value: summary.averagePercent },
      { label: 'Eng yuqori %', value: summary.maxPercent },
      { label: 'Eng past %', value: summary.minPercent },
      ...(summary.passPercent !== null
        ? [
            {
              label: `O'tish (${summary.passPercent}%)`,
              value: summary.passRate === null ? null : `${summary.passRate}%`,
            },
          ]
        : []),
    ];
    const layout: ReportLayout = {
      title: `${s.title}: natijalar`,
      fileBase: s.title,
      orientation: 'landscape',
      meta,
      kpis,
      tables: [main],
    };
    let buf: Buffer;
    if (format === 'pdf') {
      buf = await renderPdf(layout);
    } else {
      const qlist = [...pool.values()];
      const matrix: Table = {
        title: 'Savollar matritsasi',
        columns: [
          { header: 'F.I.Sh.', key: 'name', width: 30 },
          ...qlist.map((_, i) => ({
            header: `S${i + 1}`,
            key: `q${i}`,
            width: 6,
            type: 'number' as const,
            align: 'center' as const,
          })),
        ],
        rows: ranked.map((r) => {
          const a = attempts.find((x) => x.participantKey === r.key);
          const items = new Map((a?.score?.items ?? []).map((i) => [i.qid, i.got]));
          const row: Record<string, unknown> = { name: r.fullName };
          qlist.forEach((q, i) => {
            const got = items.get(String(q.questionId));
            row[`q${i}`] = got === undefined ? null : got;
          });
          return row;
        }),
      };
      const legend: Table = {
        title: 'Savollar',
        columns: [
          { header: '№', key: 'n', width: 5, type: 'int' },
          { header: 'Tur', key: 'type', width: 10 },
          { header: 'Maks. ball', key: 'pts', width: 10, type: 'number' },
          { header: 'Matn (qisqa)', key: 'text', width: 80 },
        ],
        rows: qlist.map((q, i) => ({
          n: i + 1,
          type: q.type,
          pts: q.points,
          // Savol matni (muallif kiritgan): formula belgilari sanitizatsiya qilinadi
          text: safeText(
            ((q.content ?? []) as { type?: string; text?: string; tex?: string }[])
              .map((b) => (b.type === 'text' ? b.text : b.type === 'math' ? b.tex : '[rasm]'))
              .join(' ')
              .slice(0, 200),
          ),
        })),
      };
      buf = await renderExcel({ ...layout, tables: [main, matrix, legend] });
    }
    await audit(ctx, schoolId, 'exam.session.export', s.id, null, { format, rows: rows.length });
    const name = safeFileName(s.title, dayIso, dayIso, format);
    return {
      buf,
      headers: {
        'Content-Type': contentTypeOf(format),
        'Content-Disposition': contentDisposition(name),
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
      },
    };
  },
};

export type { ExamScope };
