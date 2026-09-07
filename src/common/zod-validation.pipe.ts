import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodType, z } from 'zod';

/**
 * Generic pipe that validates a request body against a zod schema.
 * On failure, throws a BadRequestException carrying
 * { code: 'validation_failed', details: <flattened zod issues> }.
 */
export class ZodValidationPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        details: z.flattenError(result.error),
      });
    }
    return result.data;
  }
}

/** Convenience factory: ZodBody(schema) === new ZodValidationPipe(schema). */
export function ZodBody<T extends ZodType>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
