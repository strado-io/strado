import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';

describe('AppError intercom codes', () => {
  it('UNAUTHENTICATED maps to 401', () => {
    expect(new AppError('UNAUTHENTICATED', 'no token').httpStatus).toBe(401);
  });
  it('CONFLICT maps to 409', () => {
    expect(new AppError('CONFLICT', 'alias taken').httpStatus).toBe(409);
  });
  it('BACKPRESSURE maps to 429', () => {
    expect(new AppError('BACKPRESSURE', 'scope full').httpStatus).toBe(429);
  });
  it('UNAVAILABLE maps to 503', () => {
    expect(new AppError('UNAVAILABLE', 'intercom disabled').httpStatus).toBe(503);
  });
});
