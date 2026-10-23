import { createWorker } from './worker';
import { handleCloudExtension } from './extensions';
import { serveMobileAsset, type MobileAssets } from './mobile-assets';
import type { Env } from './worker';
const api = createWorker({extension:handleCloudExtension});
export default {
  async fetch(request:Request,env:Env & {ASSETS?:MobileAssets}) {
    return await serveMobileAsset(request,env.ASSETS) ?? api.fetch(request,env);
  },
};
