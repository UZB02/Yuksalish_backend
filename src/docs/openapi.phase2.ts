// 2-bosqich OpenAPI qismi: o'quv yillari, sinflar, o'quvchilar, import, dashboard
type Obj = Record<string, unknown>;

export interface DocHelpers {
  ref: (name: string) => Obj;
  okRes: (schema: Obj, description?: string) => Obj;
  errors: Obj;
  body: (schema: Obj) => Obj;
  secured: Obj[];
  idParam: Obj;
  schoolHeader: Obj;
}

export function buildPhase2(h: DocHelpers) {
  const { ref, okRes, errors, body, secured, idParam, schoolHeader } = h;
  const q = (name: string, type = 'string') => ({ name, in: 'query', schema: { type } });
  const op = (
    tag: string,
    summary: string,
    responses: Obj,
    opts: { params?: Obj[]; body?: Obj } = {},
  ) => ({
    tags: [tag],
    summary,
    security: secured,
    parameters: [schoolHeader, ...(opts.params ?? [])],
    ...(opts.body ? { requestBody: body(opts.body) } : {}),
    responses: { ...responses, ...errors },
  });
  const xlsxRes = {
    description: 'xlsx fayl (attachment)',
    content: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  };
  const idp = [idParam];
  const o = (properties: Obj, required?: string[]) => ({
    type: 'object',
    properties,
    ...(required ? { required } : {}),
  });
  const str = { type: 'string' };
  const strNull = { type: 'string', nullable: true };
  const int = { type: 'integer' };
  const ids = { type: 'array', items: str };
  const date = { type: 'string', format: 'date' };
  const dateTime = { type: 'string', format: 'date-time' };

  const tags = [
    { name: 'Academic years' },
    { name: 'Classes', description: "O'qituvchi faqat o'ziga biriktirilgan sinflarni ko'radi" },
    { name: 'Students' },
    { name: 'Students import', description: 'Excel (.xlsx) bulk import: preview -> confirm' },
    { name: 'Dashboard' },
  ];

  const schemas: Obj = {
    AcademicYear: o({
      id: str,
      name: str,
      startDate: date,
      endDate: date,
      isActive: { type: 'boolean' },
      periods: { type: 'array', items: o({ id: str, name: str, startDate: date, endDate: date }) },
      createdAt: dateTime,
    }),
    AcademicYearInput: o(
      {
        name: str,
        startDate: date,
        endDate: date,
        periods: { type: 'array', items: o({ name: str, startDate: date, endDate: date }) },
      },
      ['name', 'startDate', 'endDate'],
    ),
    Class: o({
      id: str,
      name: str,
      grade: { type: 'integer', minimum: 1, maximum: 11 },
      section: strNull,
      academicYearId: str,
      homeroomTeacherId: strNull,
      homeroomTeacher: { nullable: true, ...o({ id: str, fullName: str }) },
      teacherIds: ids,
      teachers: { type: 'array', items: o({ id: str, fullName: str }) },
      studentsCount: int,
      isArchived: { type: 'boolean' },
      createdAt: dateTime,
    }),
    Student: o({
      id: str,
      fullName: str,
      studentCode: strNull,
      birthDate: { ...date, nullable: true },
      gender: { type: 'string', enum: ['male', 'female'], nullable: true },
      classId: str,
      class: o({ id: str, name: str }),
      parentPhone: strNull,
      photoUrl: strNull,
      status: { type: 'string', enum: ['active', 'transferred', 'graduated'] },
      createdAt: dateTime,
    }),
    ImportPreview: o({
      importId: str,
      expiresAt: dateTime,
      summary: o({ total: int, valid: int, invalid: int, duplicates: int }),
      rows: {
        type: 'array',
        items: o({
          row: int,
          status: { type: 'string', enum: ['valid', 'invalid', 'duplicate'] },
          data: o({
            fullName: str,
            className: str,
            birthDate: strNull,
            gender: strNull,
            studentCode: strNull,
            parentPhone: strNull,
          }),
          resolvedClassId: strNull,
          duplicateOfStudentId: strNull,
          errors: ids,
        }),
      },
    }),
  };

  const deleted = okRes(o({ deleted: { type: 'boolean' } }));
  const classRes = { '200': okRes(ref('Class')) };
  const studentRes = { '200': okRes(ref('Student')) };
  const classFields = {
    name: str,
    grade: int,
    section: strNull,
    homeroomTeacherId: strNull,
    teacherIds: ids,
  };

  const paths: Obj = {
    '/academic-years': {
      get: op('Academic years', "O'quv yillari (barcha maktab rollari)", {
        '200': okRes({ type: 'array', items: ref('AcademicYear') }),
      }),
      post: op(
        'Academic years',
        'Yaratish (classes.manage)',
        { '201': okRes(ref('AcademicYear')) },
        { body: ref('AcademicYearInput') },
      ),
    },
    '/academic-years/{id}': {
      patch: op(
        'Academic years',
        'Tahrirlash',
        { '200': okRes(ref('AcademicYear')) },
        { params: idp, body: ref('AcademicYearInput') },
      ),
      delete: op(
        'Academic years',
        "O'chirish (sinflari bo'lsa 409)",
        { '200': deleted },
        { params: idp },
      ),
    },
    '/academic-years/{id}/activate': {
      post: op(
        'Academic years',
        "Faol qilish (boshqalari nofaol bo'ladi)",
        { '200': okRes(ref('AcademicYear')) },
        { params: idp },
      ),
    },
    '/classes': {
      get: op(
        'Classes',
        'Sinflar (default: faol yil, arxivlanmagan)',
        { '200': okRes({ type: 'array', items: ref('Class') }) },
        {
          params: [
            q('academicYearId'),
            q('grade', 'integer'),
            q('search'),
            q('isArchived', 'boolean'),
            q('page', 'integer'),
            q('limit', 'integer'),
          ],
        },
      ),
      post: op(
        'Classes',
        'Yaratish (classes.manage)',
        { '201': okRes(ref('Class')) },
        {
          body: o({ ...classFields, academicYearId: str }, ['name', 'grade']),
        },
      ),
    },
    '/classes/{id}': {
      get: op('Classes', 'Sinf', classRes, { params: idp }),
      patch: op('Classes', 'Tahrirlash', classRes, { params: idp, body: o(classFields) }),
    },
    '/classes/{id}/archive': { post: op('Classes', 'Arxivlash', classRes, { params: idp }) },
    '/classes/{id}/unarchive': {
      post: op('Classes', 'Arxivdan qaytarish', classRes, { params: idp }),
    },
    '/classes/{id}/teachers': {
      put: op(
        'Classes',
        "Sinf o'qituvchilarini almashtirish (rahbar teacherIds ichida bo'lishi shart)",
        classRes,
        {
          params: idp,
          body: o({ teacherIds: ids, homeroomTeacherId: strNull }, [
            'teacherIds',
            'homeroomTeacherId',
          ]),
        },
      ),
    },
    '/teachers/{id}/classes': {
      put: op(
        'Teachers',
        "O'qituvchi sinflarini to'liq almashtirish (teachers.manage)",
        { '200': okRes(ref('User')) },
        {
          params: idp,
          body: o({ classIds: ids }, ['classIds']),
        },
      ),
    },
    '/students': {
      get: op(
        'Students',
        "O'quvchilar (students.view yoki scores.create; o'qituvchi faqat o'z sinflari)",
        { '200': okRes({ type: 'array', items: ref('Student') }) },
        {
          params: [
            q('classId'),
            q('status'),
            q('search'),
            q('page', 'integer'),
            q('limit', 'integer'),
          ],
        },
      ),
      post: op(
        'Students',
        'Yaratish (students.manage)',
        { '201': okRes(ref('Student')) },
        {
          body: o(
            {
              fullName: str,
              studentCode: strNull,
              birthDate: strNull,
              gender: strNull,
              classId: str,
              parentPhone: strNull,
              photoUrl: strNull,
              status: str,
            },
            ['fullName', 'classId'],
          ),
        },
      ),
    },
    '/students/{id}': {
      get: op('Students', "O'quvchi", studentRes, { params: idp }),
      patch: op('Students', 'Tahrirlash', studentRes, {
        params: idp,
        body: o({
          fullName: str,
          studentCode: strNull,
          birthDate: strNull,
          gender: strNull,
          parentPhone: strNull,
          photoUrl: strNull,
          status: str,
        }),
      }),
      delete: op('Students', 'Soft delete', { '200': deleted }, { params: idp }),
    },
    '/students/{id}/transfer': {
      post: op('Students', "Boshqa sinfga o'tkazish (tarix saqlanadi)", studentRes, {
        params: idp,
        body: o({ classId: str }, ['classId']),
      }),
    },
    '/students/export': {
      get: op('Students', 'Excelga eksport', { '200': xlsxRes }, { params: [q('classId')] }),
    },
    '/students/import/template': {
      get: op('Students import', 'Shablon (xlsx)', { '200': xlsxRes }),
    },
    '/students/import/preview': {
      post: {
        ...op(
          'Students import',
          "Oldindan ko'rish (DB ga yozilmaydi). multipart: file (.xlsx, <=5MB, <=1000 qator), classId?",
          {
            '200': okRes(ref('ImportPreview')),
          },
        ),
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: o({ file: { type: 'string', format: 'binary' }, classId: str }, ['file']),
            },
          },
        },
      },
    },
    '/students/import/confirm': {
      post: op(
        'Students import',
        'Tasdiqlash',
        { '200': okRes(o({ created: int, updated: int, skipped: int, failed: int })) },
        {
          body: o({ importId: str, onDuplicate: { type: 'string', enum: ['skip', 'update'] } }, [
            'importId',
          ]),
        },
      ),
    },
    '/students/import/{importId}/errors': {
      get: op(
        'Students import',
        'Xato/dublikat qatorlar (xlsx)',
        { '200': xlsxRes },
        {
          params: [{ name: 'importId', in: 'path', required: true, schema: str }],
        },
      ),
    },
    '/teachers/import/template': {
      get: op('Teachers import', 'Shablon (xlsx, teachers.manage)', { '200': xlsxRes }),
    },
    '/teachers/import/preview': {
      post: {
        ...op(
          'Teachers import',
          "Oldindan ko'rish (DB ga yozilmaydi). multipart: file (.xlsx, <=5MB, <=500 qator)",
          { '200': okRes(o({ summary: o({}), rows: { type: 'array', items: o({}) } })) },
        ),
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: o({ file: { type: 'string', format: 'binary' } }, ['file']),
            },
          },
        },
      },
    },
    '/teachers/import/confirm': {
      post: {
        ...op(
          'Teachers import',
          "Tasdiqlash: o'sha fayl qayta yuboriladi, server qayta tekshirib yaratadi. Javobda yaratilganlarning parollari (saqlanmaydi)",
          { '200': okRes(o({ summary: o({}), results: { type: 'array', items: o({}) } })) },
        ),
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: o({ file: { type: 'string', format: 'binary' } }, ['file']),
            },
          },
        },
      },
    },
    '/dashboard/summary': {
      get: op(
        'Dashboard',
        "Umumiy ko'rsatkichlar (dashboard.view). Superadmin X-School-Id bermasa — global",
        {
          '200': okRes(
            o({ students: int, classes: int, teachers: int, scoresToday: int, schools: int }),
          ),
        },
      ),
    },
  };

  return { tags, schemas, paths };
}
