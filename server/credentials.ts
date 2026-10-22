import type { ConnectorId } from '../shared/connectors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
export type CredentialName = 'organatoApiKey' | 'googleClientSecret' | 'cloudSession' | `connector-${ConnectorId}`;
/** Credentials never enter state.json. Explicit test data directories use an isolated Keychain account. */
export class Credentials {
  private readonly service: string;
  private readonly volatile = new Map<CredentialName, string>();
  constructor(directory: string) { this.service = `app.centre.credentials.${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`; }
  async get(name: CredentialName): Promise<string> {
    const environment = name === 'organatoApiKey' ? process.env.ORGANATO_API_KEY : name === 'googleClientSecret' ? process.env.GOOGLE_CLIENT_SECRET : undefined;
    if (environment && name !== 'googleClientSecret') return environment;
    if (process.platform !== 'darwin') return this.volatile.get(name) ?? environment ?? '';
    try { return (await execute('/usr/bin/security', ['find-generic-password', '-a', name, '-s', this.service, '-w'])).stdout.trim(); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 44) return environment ?? ''; throw new Error('Could not read Centre credentials from macOS Keychain.'); }
  }
  async set(name: CredentialName, value: string) {
    if (process.platform !== 'darwin') {
      if (value) throw new Error('Persistent credential storage requires macOS Keychain. Set credentials through environment variables on this platform.');
      this.volatile.delete(name); return;
    }
    if (!value) {
      try { await execute('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', this.service]); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 44)) throw new Error('Could not remove Centre credential from Keychain.'); }
      return;
    }
    if (/[\r\n\0]/.test(value)) throw new Error('Credentials cannot contain line breaks or null characters.');
    const quoted = `"${value.replace(/[\\"]/g, character => `\\${character}`)}"`;
    try {
      // Interactive stdin keeps the password out of process arguments. Never log this input.
      await new Promise<void>((resolve, reject) => {
        const child = execFile('/usr/bin/security', ['-i'], error => error ? reject(error) : resolve());
        child.stdin?.end(`add-generic-password -U -a ${name} -s ${this.service} -w ${quoted}\n`);
      });
    }
    catch { throw new Error('Could not save Centre credential in macOS Keychain.'); }
  }
}
