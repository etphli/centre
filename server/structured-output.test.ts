import assert from 'node:assert/strict';
import test from 'node:test';
import { generatedResourceSchema } from './resources';
import { structuredOutputSchema } from './structured-output';
import { chatResponseSchema } from './chat-response';

test('generated resource output uses model-supported unions and retains question validation',() => {
  const schema = structuredOutputSchema(generatedResourceSchema);
  assert.doesNotMatch(JSON.stringify(schema),/"oneOf"/);
  assert.match(JSON.stringify(schema),/"anyOf"/);
  assert.doesNotMatch(JSON.stringify(structuredOutputSchema(chatResponseSchema)),/"oneOf"/);
  assert.equal(generatedResourceSchema.safeParse({title:'Quiz',content:'',questions:[{responseType:'multiple_choice',prompt:'Choose',answer:'Missing',choices:['A','B']}]}).success,false);
});
