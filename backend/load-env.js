import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const values = parseEnv(readFileSync(envFile, 'utf8'));

for (const [name, value] of Object.entries(values)) {
  process.env[name] = value;
}
