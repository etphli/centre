import { build } from 'esbuild';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import './build-icon.mjs';

const googleOAuthSchema = z.object({ clientId: z.string().min(1).max(1000), clientSecret: z.string().min(1).max(1000) }).strict();
const googleOAuthSourceSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1).max(1000),
    client_secret: z.string().min(1).max(1000),
    redirect_uris: z.array(z.string().url()).optional(),
  }).passthrough(),
}).strict();

async function readGoogleOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (clientId !== undefined || clientSecret !== undefined) {
    if (!clientId || !clientSecret) throw new Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to build Centre.');
    return googleOAuthSchema.parse({ clientId, clientSecret });
  }

  const sourceFile = process.env.GOOGLE_OAUTH_SOURCE ?? '.runtime/google-oauth-source.json';
  let input;
  try {
    input = JSON.parse(await readFile(sourceFile, 'utf8'));
  } catch {
    throw new Error('A valid Google Desktop OAuth config is required. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or provide .runtime/google-oauth-source.json.');
  }
  const source = googleOAuthSourceSchema.safeParse(input);
  if (!source.success) throw new Error('The Google OAuth source must be a valid installed-app client config.');
  return googleOAuthSchema.parse({ clientId: source.data.installed.client_id, clientSecret: source.data.installed.client_secret });
}

const googleOAuth = await readGoogleOAuthConfig();
await mkdir('dist-electron', { recursive: true, mode: 0o700 });
const googleOAuthFile = 'dist-electron/google-oauth.json';
await writeFile(googleOAuthFile, `${JSON.stringify(googleOAuth)}\n`, { mode: 0o600 });
await chmod(googleOAuthFile, 0o600);

await build({
  entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron', 'electron-updater', 'pdfjs-dist'], sourcemap: true,
});
await build({
  entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'],
});
