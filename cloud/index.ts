import { createWorker } from './worker';
import { handleCloudExtension } from './extensions';
export default createWorker({extension:handleCloudExtension});
