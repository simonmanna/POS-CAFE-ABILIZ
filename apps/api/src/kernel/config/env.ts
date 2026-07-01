import { Logger } from '@nestjs/common';

/**
 * D4-1: refuse-to-start guard. The previous JWT service silently fell back to
 * `dev-access-secret-change-me` if `JWT_ACCESS_SECRET` was unset — which meant
 * a misconfigured production deploy would accept forged tokens. Now boot fails
 * loudly instead.
 *
 * Call once at startup from `main.ts` before NestFactory.create().
 */

const PLACEHOLDER_SECRETS = new Set([
  'dev-access-secret-change-me',
  'dev-refresh-secret-change-me',
  '',
  'changeme',
  'secret',
]);

const MIN_SECRET_LENGTH = 32;

export interface EnvValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateEnv(): EnvValidationResult {
  const errors: string[] = [];
  const logger = new Logger('EnvValidation');

  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const value = process.env[key];
    if (!value) {
      errors.push(`${key} is not set`);
      continue;
    }
    if (PLACEHOLDER_SECRETS.has(value)) {
      errors.push(`${key} is set to a known development placeholder; refuse to start`);
    }
    if (value.length < MIN_SECRET_LENGTH) {
      errors.push(`${key} must be at least ${MIN_SECRET_LENGTH} characters long`);
    }
  }

  // Database URL is required.
  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL is not set');
  }

  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(err);
    }
    return { ok: false, errors };
  }

  return { ok: true, errors: [] };
}