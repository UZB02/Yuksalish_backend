import { ALL_PERMISSION_KEYS, TEACHER_BASE_PERMISSIONS } from '../../constants/permissions';
import type { Role } from '../../constants/roles';
import type { IUser } from '../../models/User';
import { uniq } from '../../utils/helpers';
import { photoUrl } from '../photos/photos.url';

/** Samarali ruxsatlar: superadmin — hammasi, o'qituvchi — saqlanganlar + asosiy ruxsat */
export function effectivePermissions(role: Role, stored: string[]): string[] {
  if (role === 'superadmin') return [...ALL_PERMISSION_KEYS];
  if (role === 'teacher') return uniq([...TEACHER_BASE_PERMISSIONS, ...stored]);
  return [...stored];
}

type UserLike = Pick<
  IUser,
  | 'fullName'
  | 'username'
  | 'role'
  | 'schoolId'
  | 'permissions'
  | 'isActive'
  | 'lastLoginAt'
  | 'createdAt'
  | 'phone'
> & { id: string; photoId?: IUser['photoId'] };

export function toUserDto(u: UserLike) {
  return {
    id: u.id,
    fullName: u.fullName,
    username: u.username,
    role: u.role,
    schoolId: u.schoolId ? String(u.schoolId) : null,
    phone: u.phone ?? null,
    /** Imzolangan rasm havolasi (yoki null) */
    photo: photoUrl(u.photoId),
    permissions: effectivePermissions(u.role, u.permissions),
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}
