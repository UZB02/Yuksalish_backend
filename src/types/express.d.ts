import type { Role } from '../constants/roles';

export interface AuthUser {
  id: string;
  role: Role;
  schoolId: string | null;
  fullName: string;
  username: string;
  /** Samarali ruxsatlar (superadmin — hammasi, teacher — asosiy ruxsat bilan) */
  permissions: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Tenant middleware aniqlagan maktab */
      schoolId?: string;
    }
  }
}
