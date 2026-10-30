import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/updates';
import { latestPublicRelease, newerRelease } from './public-releases';
export type { UpdateStatus } from '../shared/updates';
const run = promisify(execFile);
export function createUpdater() {
  let status:UpdateStatus={state:'idle',currentVersion:app.getVersion(),message:'Check for Centre updates. No GitHub account required.'};
  let checking:Promise<UpdateStatus>|undefined;
  autoUpdater.autoDownload=true;
  autoUpdater.autoInstallOnAppQuit=false;
  autoUpdater.logger=null;
  autoUpdater.on('checking-for-update',()=>{status={...status,state:'checking',message:'Checking public GitHub releases…'};});
  autoUpdater.on('update-available',info=>{status={...status,state:'downloading',version:info.version,message:`Downloading Centre ${info.version}…`};});
  autoUpdater.on('download-progress',progress=>{status={...status,message:`Downloading update: ${Math.round(progress.percent)}%`};});
  autoUpdater.on('update-not-available',()=>{status={...status,state:'current',message:'You have the latest published version of Centre.'};});
  autoUpdater.on('update-downloaded',info=>{status={...status,state:'ready',version:info.version,downloaded:true,message:`Centre ${info.version} is ready. Restart to install.`};});
  autoUpdater.on('error',()=>{status={...status,state:status.downloadUrl?'available':'error',downloaded:false,message:'Automatic update failed. Download the installer or check again.'};});
  async function signedApplication() {
    if(!app.isPackaged || process.platform!=='darwin') return false;
    const bundle=dirname(dirname(dirname(app.getPath('exe'))));
    try {
      const result=await run('/usr/bin/codesign',['-dv','--verbose=4',bundle]);
      if(!result.stderr.includes('Authority=Developer ID Application:') || result.stderr.includes('Signature=adhoc')) return false;
      await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);return true;
    } catch {return false;}
  }
  async function check():Promise<UpdateStatus> {
    if(checking) return checking;
    if(status.state==='ready') return status;
    status={state:'checking',currentVersion:app.getVersion(),message:'Checking public GitHub releases…'};
    checking=(async()=>{
      try {
        const release=await latestPublicRelease(process.arch);
        status={...status,...release,downloaded:false};
        if(!newerRelease(release.version,app.getVersion())) {status={...status,state:'current',downloadUrl:undefined,message:`You have the latest published version. Latest release: ${release.version}.`};return status;}
        if(!release.automatic || !await signedApplication()) {
          status={...status,state:'available',message:release.downloadUrl?`Centre ${release.version} is available. Open the DMG and drag Centre into Applications to update.`:'A new Centre release is available. Open Releases to find its installer.'};return status;
        }
        autoUpdater.setFeedURL({provider:'github',owner:'etphli',repo:'centre',private:false});
        const result=await autoUpdater.checkForUpdates();
        if(result?.downloadPromise) await result.downloadPromise;
      } catch(error) { status={...status,state:status.downloadUrl?'available':'error',downloaded:false,message:error instanceof Error?error.message:'Could not check for updates. Try again.'}; }
      return status;
    })();
    try{return await checking;}finally{checking=undefined;}
  }
  return {
    check,status:async()=>status,
    async install() {
      if(status.state!=='ready' || !status.downloaded) throw new Error('Check for updates and wait for the download to finish first.');
      if(!await signedApplication()) throw new Error('Automatic installation requires a signed release. Download the DMG instead.');
      autoUpdater.quitAndInstall(false,true);return status;
    },
  };
}
