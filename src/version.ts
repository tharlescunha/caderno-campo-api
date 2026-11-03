import { readFileSync } from 'node:fs';

// package.json sits one level above src/ (development) and dist/ (production)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION = pkg.version;
