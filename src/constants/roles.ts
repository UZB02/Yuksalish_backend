export const ROLES = ['superadmin', 'school_admin', 'teacher'] as const;
export type Role = (typeof ROLES)[number];
