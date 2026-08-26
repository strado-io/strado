export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  GIT_DIRTY: 'GIT_DIRTY',
  NOT_SYMLINK: 'NOT_SYMLINK',
  PORT_IN_USE: 'PORT_IN_USE',
  SOURCE_MISSING: 'SOURCE_MISSING',
  PROCESS_ALREADY_RUNNING: 'PROCESS_ALREADY_RUNNING',
  NOT_FOUND: 'NOT_FOUND',
  SHELL_FAILED: 'SHELL_FAILED',
  PATH_FORBIDDEN: 'PATH_FORBIDDEN',
  LOCKFILE_MISMATCH: 'LOCKFILE_MISMATCH',
  WORKSPACE_HAS_RUNNING_PROCESSES: 'WORKSPACE_HAS_RUNNING_PROCESSES',
  FEEDBACK_SEND_FAILED: 'FEEDBACK_SEND_FAILED',
  // strado-api unreachable/erroring — a transient upstream problem, not
  // something the user got wrong, so the UI can offer a retry.
  CLOUD_UNREACHABLE: 'CLOUD_UNREACHABLE',
  // A container with the name we need exists but belongs to another worktree.
  // Never resolved by forcing: removing it would destroy that worktree's work.
  SANDBOX_CONFLICT: 'SANDBOX_CONFLICT',
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;

const httpStatusByCode: Record<ErrorCodeName, number> = {
  VALIDATION: 400,
  GIT_DIRTY: 409,
  NOT_SYMLINK: 409,
  PORT_IN_USE: 409,
  SOURCE_MISSING: 404,
  PROCESS_ALREADY_RUNNING: 409,
  NOT_FOUND: 404,
  SHELL_FAILED: 500,
  PATH_FORBIDDEN: 403,
  LOCKFILE_MISMATCH: 200,
  WORKSPACE_HAS_RUNNING_PROCESSES: 409,
  FEEDBACK_SEND_FAILED: 502,
  CLOUD_UNREACHABLE: 502,
  SANDBOX_CONFLICT: 409,
};

export class AppError extends Error {
  readonly code: ErrorCodeName;
  readonly details?: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCodeName, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatusByCode[code];
  }
}

// Auth-origin provider failure (bad/expired/underscoped token, or a 404 that
// means "token can't see the repo"). Routes map exactly this to
// `needsAuth` — every other VALIDATION (merge conflict, MR exists) must
// surface its message instead of a reconnect prompt.
export class AuthError extends AppError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

export type ErrorResponse = {
  error: { code: ErrorCodeName; message: string; details?: unknown };
};

export function toResponse(err: unknown): ErrorResponse {
  if (err instanceof AppError) {
    // PATH_FORBIDDEN's details carry absolute host filesystem paths (target, allowedRoots)
    // that are only useful for server-side logging — never send them to the client.
    const details = err.code === 'PATH_FORBIDDEN' ? undefined : err.details;
    return { error: { code: err.code, message: err.message, details } };
  }
  if (err instanceof Error) {
    return { error: { code: 'SHELL_FAILED', message: err.message, details: undefined } };
  }
  return { error: { code: 'SHELL_FAILED', message: String(err), details: undefined } };
}
