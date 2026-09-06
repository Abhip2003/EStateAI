import { z } from 'zod';

// z.coerce.boolean() is a trap for query params: Boolean("false") is
// `true` in JS, so `?flag=false` would coerce to `true`. This parses the
// literal strings instead.
export const booleanQueryParam = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

export function formatValidationErrors(error: z.ZodError) {
  return {
    status: 'error',
    message: 'Validation failed',
    errors: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
