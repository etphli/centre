export type MobileDistribution = { kind: 'testflight' | 'app-store'; url: string };

/** Installation links carry no account authority and never point at an IPA. */
export function mobileDistribution(value: string | undefined): MobileDistribution | null {
  if (!value?.trim()) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.hostname === 'testflight.apple.com' && /^\/join\/[a-zA-Z0-9]{8}$/.test(url.pathname)) {
    return { kind: 'testflight', url: url.href };
  }
  if (url.hostname === 'apps.apple.com' && /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id[1-9]\d{5,12}$/.test(url.pathname)) {
    return { kind: 'app-store', url: url.href };
  }
  return null;
}

/** Public Home Screen installation guide; carries no account authority. */
export const mobileWebInstallationUrl = 'https://centre-cloud.etphli.workers.dev/iphone/';
