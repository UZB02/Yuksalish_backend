import type { Role } from './roles';

export interface PermissionDef {
  key: string;
  group: string;
  label: string;
  roles: Exclude<Role, 'superadmin'>[];
}

// Ruxsatlar katalogi (superadmin hammasiga ega, shuning uchun roles ro'yxatida yo'q)
export const PERMISSION_CATALOG: PermissionDef[] = [
  {
    key: 'dashboard.view',
    group: 'Dashboard',
    label: "Dashboardni ko'rish",
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'classes.manage',
    group: 'Sinflar',
    label: 'Sinflarni boshqarish',
    roles: ['school_admin'],
  },
  {
    key: 'students.view',
    group: "O'quvchilar",
    label: "O'quvchilarni ko'rish",
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'students.manage',
    group: "O'quvchilar",
    label: "O'quvchilarni boshqarish",
    roles: ['school_admin'],
  },
  {
    key: 'teachers.manage',
    group: "O'qituvchilar",
    label: "O'qituvchilarni boshqarish",
    roles: ['school_admin'],
  },
  {
    key: 'scores.create',
    group: 'Baholar',
    label: "Ball qo'yish",
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'scores.edit',
    group: 'Baholar',
    label: "Ballarni tahrirlash va o'chirish",
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'grades.create',
    group: 'Fan baholari',
    label: "Fan bahosi qo'yish",
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'grades.edit',
    group: 'Fan baholari',
    label: "Fan baholarini tahrirlash va o'chirish",
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'subjects.manage',
    group: 'Fanlar',
    label: 'Fanlarni boshqarish',
    roles: ['school_admin'],
  },
  {
    key: 'reports.view',
    group: 'Hisobotlar',
    label: "Hisobotlarni ko'rish",
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'reports.export',
    group: 'Hisobotlar',
    label: 'Hisobotlarni eksport qilish',
    roles: ['school_admin', 'teacher'],
  },
  { key: 'audit.view', group: 'Audit', label: "Audit logni ko'rish", roles: ['school_admin'] },
  {
    key: 'attendance.take',
    group: 'Davomat',
    label: 'Davomat olish',
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'attendance.edit',
    group: 'Davomat',
    label: 'Davomatni tahrirlash',
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'attendance.view',
    group: 'Davomat',
    label: "Davomat statistikasini ko'rish",
    roles: ['school_admin', 'teacher'],
  },
  {
    key: 'attendance.settings',
    group: 'Davomat',
    label: 'Davomat sozlamalari',
    roles: ['school_admin'],
  },
];

export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);

// O'qituvchida doim mavjud asosiy ruxsat
export const TEACHER_BASE_PERMISSIONS = ['scores.create', 'grades.create', 'attendance.take'];

// Rol uchun berilishi mumkin bo'lgan kalitlar
export function permissionsForRole(role: Role): string[] {
  if (role === 'superadmin') return ALL_PERMISSION_KEYS;
  return PERMISSION_CATALOG.filter((p) => p.roles.includes(role)).map((p) => p.key);
}
