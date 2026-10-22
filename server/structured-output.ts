import { z } from 'zod';

export function structuredOutputSchema(schema:z.ZodType) {
  return z.toJSONSchema(schema,{
    override:({jsonSchema}) => {
      // Zod emits oneOf for disjoint discriminated unions; strict model output accepts anyOf.
      if (jsonSchema.oneOf) {
        jsonSchema.anyOf = jsonSchema.oneOf;
        delete jsonSchema.oneOf;
      }
    },
  });
}
