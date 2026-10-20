import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

if (process.platform === 'darwin') {
  const run = promisify(execFile);
  const directory = 'dist-electron';
  const iconset = join(directory, 'Centre.iconset');
  await mkdir(iconset, { recursive: true });
  const source = join(directory, 'icon.svg');
  const png = join(directory, 'icon.png');
  await writeFile(source, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<rect x="56" y="56" width="912" height="912" rx="220" fill="#282827"/>
<path d="M 686 320 C 640 272 583 250 510 250 C 362 250 258 360 258 512 C 258 664 362 774 510 774 C 583 774 640 752 686 704" fill="none" stroke="#ede8df" stroke-width="90" stroke-linecap="round"/>
<circle cx="747" cy="512" r="48" fill="#c99a7d"/>
</svg>`);
  await run('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', png]);
  for (const size of [16, 32, 128, 256, 512]) {
    await run('/usr/bin/sips', ['-z', String(size), String(size), png, '--out', join(iconset, `icon_${size}x${size}.png`)]);
    await run('/usr/bin/sips', ['-z', String(size * 2), String(size * 2), png, '--out', join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(directory, 'icon.icns')]);
  await rm(iconset, { recursive: true, force: true });
}
