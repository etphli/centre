import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

export function paperSandboxProfile(executable: string, directory: string) {
  const workDirectory = realpathSync(directory);
  const binary = realpathSync(executable);
  const readable = [
    '/System', '/usr/lib', '/usr/share', '/Library/Fonts', '/Library/Apple',
    '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/usr/local/Cellar', '/usr/local/opt',
    '/private/etc', '/private/var/db/timezone',
    join(homedir(), 'Library/Fonts'),
  ];
  const cache = join(homedir(), 'Library/Caches/Tectonic');
  return `(version 1)
(allow default)
(deny file-read-data file-write*)
(allow file-read-data ${readable.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')})
(allow file-read-data (literal "/") (literal ${JSON.stringify(binary)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (literal "/dev/null"))
(allow file-read-data file-write* (subpath ${JSON.stringify(workDirectory)}) (subpath ${JSON.stringify(cache)}))
(allow file-read-data (literal ${JSON.stringify(join(homedir(), 'Library/Application Support/Tectonic/config.toml'))}))
(deny process-exec)
(allow process-exec (literal ${JSON.stringify(binary)}))`;
}
