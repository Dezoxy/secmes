import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ZodValidationPipe } from './zod-validation.pipe.js';

const schema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('coerces a valid query string to the typed value', () => {
    expect(pipe.transform({ limit: '20' })).toEqual({ limit: 20 });
  });

  it('applies schema defaults when omitted', () => {
    expect(pipe.transform({})).toEqual({ limit: 50 });
  });

  it('rejects out-of-range values (400)', () => {
    expect(() => pipe.transform({ limit: '0' })).toThrow(BadRequestException);
    expect(() => pipe.transform({ limit: '999' })).toThrow(BadRequestException);
  });

  it('rejects non-numeric values (400)', () => {
    expect(() => pipe.transform({ limit: 'abc' })).toThrow(BadRequestException);
  });
});
