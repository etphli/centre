import { handleAiRequest } from '../cloud-ai/index';
import { handleOrganatoRequest } from '../cloud-organato/index';
import { cloudMutationSchema } from '../shared/cloud';
import type { ExtensionContext } from './worker';

/** Both modules receive only the authenticated Centre workspace repository. */
export async function handleCloudExtension(request:Request,context:ExtensionContext):Promise<Response|null> {
  const ai = await handleAiRequest(request,context);
  if (ai) return ai;
  return handleOrganatoRequest(request,{
    ...context,
    entities:{
      get:(kind,id)=>context.entities.get(kind,id),
      put:mutation=>context.entities.put(cloudMutationSchema.parse(mutation)),
      commit:mutations=>context.entities.commit(mutations.map(mutation=>cloudMutationSchema.parse(mutation))),
    },
  });
}
