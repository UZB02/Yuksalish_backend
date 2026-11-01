export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorDetail {
  path: string;
  message: string;
}

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.status = STATUS[code];
  }

  static validation(message = "Ma'lumotlar noto'g'ri", details?: ErrorDetail[]) {
    return new AppError('VALIDATION_ERROR', message, details);
  }
  static unauthorized(message = "Avtorizatsiyadan o'tilmagan") {
    return new AppError('UNAUTHORIZED', message);
  }
  static forbidden(message = "Bu amalni bajarishga ruxsat yo'q") {
    return new AppError('FORBIDDEN', message);
  }
  static notFound(message = 'Topilmadi') {
    return new AppError('NOT_FOUND', message);
  }
  static conflict(message: string, details?: ErrorDetail[]) {
    return new AppError('CONFLICT', message, details);
  }
  static badGateway(message: string) {
    return new AppError('BAD_GATEWAY', message);
  }
  static unavailable(message: string) {
    return new AppError('SERVICE_UNAVAILABLE', message);
  }
  static rateLimited(message = "So'rovlar juda ko'p. Keyinroq urinib ko'ring") {
    return new AppError('RATE_LIMITED', message);
  }
}
