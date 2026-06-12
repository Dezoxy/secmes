import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request } from 'express';

function resolveOperatorKey(): string {
  const file = process.env.OPERATOR_API_KEY_FILE;
  if (!file) throw new Error('OPERATOR_API_KEY_FILE is not set');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(file, 'utf8').trim();
}

/** Protects operator endpoints with a long-lived API key from Key Vault. Not JWT. */
@Injectable()
export class OperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers['authorization'] ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let expected: string;
    try {
      expected = resolveOperatorKey();
    } catch {
      throw new UnauthorizedException('operator key not configured');
    }

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);
    const valid =
      token.length > 0 &&
      tokenBuf.length === expectedBuf.length &&
      timingSafeEqual(tokenBuf, expectedBuf);
    if (!valid) throw new UnauthorizedException('invalid operator key');
    return true;
  }
}
