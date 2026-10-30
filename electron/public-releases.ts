import { z } from 'zod';
export const releasesUrl = 'https://github.com/etphli/centre/releases';
const releaseSchema = z.object({tag_name:z.string().regex(/^v?\d+\.\d+\.\d+$/),draft:z.literal(false),prerelease:z.literal(false),html_url:z.string().url(),assets:z.array(z.object({name:z.string(),browser_download_url:z.string().url()}))});
function versionParts(value:string) { return (value.replace(/^v/,'').split('-')[0] ?? '').split('.').map(Number); }
export function newerRelease(latest:string,current:string) {
  const left=versionParts(latest),right=versionParts(current);
  for (let index=0;index<3;index++) { const delta=(left[index] ?? 0)-(right[index] ?? 0); if(delta) return delta>0; }
  return false;
}
export async function latestPublicRelease(arch:string,fetcher:typeof fetch=fetch) {
  const response=await fetcher('https://api.github.com/repos/etphli/centre/releases/latest',{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20_000),redirect:'error'});
  if(!response.ok) throw new Error(response.status===404?'No published Centre release is available yet.':response.status===403||response.status===429?'GitHub is limiting update checks. Try again later.':`GitHub returned HTTP ${response.status}. Try again.`);
  const parsed=releaseSchema.safeParse(await response.json());
  if(!parsed.success) throw new Error('GitHub returned unreadable release details. Try again later.');
  const release=parsed.data;
  const version=release.tag_name.replace(/^v/,'');
  const releaseUrl=`${releasesUrl}/tag/${release.tag_name}`;
  if(release.html_url!==releaseUrl) throw new Error('GitHub returned an unexpected Centre release URL.');
  const dmgName=`Centre-${version}-${arch}.dmg`;
  const downloadUrl=release.assets.find(asset=>asset.name===dmgName)?.browser_download_url;
  if(downloadUrl && downloadUrl!==`${releasesUrl}/download/${release.tag_name}/${dmgName}`) throw new Error('GitHub returned an unexpected Centre installer URL.');
  const automatic=release.assets.some(asset=>asset.name===`Centre-${version}-${arch}.zip`) && release.assets.some(asset=>/^latest-mac.*\.yml$/.test(asset.name));
  return {version,releaseUrl,downloadUrl,automatic};
}
