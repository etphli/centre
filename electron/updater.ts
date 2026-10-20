import { execFile, spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { z } from 'zod';

const run = promisify(execFile);
const keychainArgs = ['-a', 'github-update-token', '-s', 'au.com.centre.desktop'];

function writeToken(token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Interactive input keeps the token out of process arguments and error messages.
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('macOS Keychain did not respond.')); }, 15_000);
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Could not access macOS Keychain.')); });
    child.on('close', (code) => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error('macOS Keychain could not save the GitHub token.')); });
    child.stdin.on('error', () => {});
    child.stdin.end(`add-generic-password -U -a github-update-token -s au.com.centre.desktop -w ${token}\n`);
  });
}
export type UpdateStatus = {
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'unavailable' | 'error';
  message: string;
  configured: boolean;
  version?: string;
  downloaded?: boolean;
};

export function createUpdater() {
  let status: UpdateStatus = { state: 'idle', message: 'Check for Centre updates.', configured: false };
  let token = '';
  let checking: Promise<UpdateStatus> | undefined;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => { status = { ...status, state: 'checking', message: 'Checking GitHub releases...' }; });
  autoUpdater.on('update-available', (info) => { status = { ...status, state: 'downloading', version: info.version, message: `Downloading Centre ${info.version}...` }; });
  autoUpdater.on('download-progress', (progress) => { status = { ...status, message: `Downloading update: ${Math.round(progress.percent)}%` }; });
  autoUpdater.on('update-not-available', () => { status = { ...status, state: 'current', message: 'You have the latest version of Centre.' }; });
  autoUpdater.on('update-downloaded', (info) => { status = { ...status, state: 'ready', version: info.version, downloaded: true, message: `Centre ${info.version} is ready. Restart to install.` }; });
  autoUpdater.on('error', () => { status = { ...status, state: 'error', downloaded: false, message: 'The update failed. Check your GitHub token, repository access, and signed release assets.' }; });

  async function readToken() {
    if (process.platform !== 'darwin') return '';
    try { return (await run('/usr/bin/security', ['find-generic-password', ...keychainArgs, '-w'])).stdout.trim(); }
    catch { return ''; }
  }

  async function signedApplication() {
    if (!app.isPackaged || process.platform !== 'darwin') return false;
    const bundle = dirname(dirname(dirname(app.getPath('exe'))));
    try {
      const result = await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
      if (!result.stderr.includes('Authority=Developer ID Application:') || result.stderr.includes('Signature=adhoc')) return false;
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
      return true;
    } catch { return false; }
  }

  async function check(): Promise<UpdateStatus> {
    if (checking) return checking;
    checking = (async () => {
      token = await readToken();
      status = { ...status, configured: Boolean(token) };
      if (!await signedApplication()) {
        status = { ...status, state: 'unavailable', message: 'Automatic installation requires a Developer ID signed Centre release. This local build can be replaced manually.' };
        return status;
      }
      if (!token) {
        status = { ...status, state: 'unavailable', message: 'Save a GitHub token with read access to etphli/centre to check its private releases.' };
        return status;
      }
      autoUpdater.setFeedURL({ provider: 'github', owner: 'etphli', repo: 'centre', private: true, token });
      try {
        const result = await autoUpdater.checkForUpdates();
        if (result?.downloadPromise) await result.downloadPromise;
      } catch {
        status = { ...status, state: 'error', downloaded: false, message: 'Could not update Centre. Check the GitHub token and whether a signed release exists in etphli/centre.' };
      }
      return status;
    })();
    try { return await checking; } finally { checking = undefined; }
  }

  return {
    check,
    async status() {
      if (!status.configured) status = { ...status, configured: Boolean(await readToken()) };
      return status;
    },
    async configure(value: unknown) {
      const input = z.object({ token: z.string().trim().max(1024).regex(/^[A-Za-z0-9_]*$/) }).parse(value);
      if (process.platform !== 'darwin') throw new Error('Private release credentials currently require macOS Keychain.');
      if (checking) throw new Error('Wait for the current update check to finish before changing credentials.');
      if (input.token) await writeToken(input.token);
      else {
        try { await run('/usr/bin/security', ['delete-generic-password', ...keychainArgs]); } catch { /* An absent token already has the requested state. */ }
      }
      token = input.token;
      status = { state: 'idle', configured: Boolean(token), message: token ? 'GitHub token saved in macOS Keychain.' : 'GitHub update token removed.' };
      return status;
    },
    async install() {
      if (status.state !== 'ready' || !status.downloaded) throw new Error('Check for updates and wait for the download to finish first.');
      if (!await signedApplication()) throw new Error('Only signed Centre releases support automatic installation.');
      autoUpdater.quitAndInstall(false, true);
      return status;
    },
  };
}
