import { readFileSync } from 'fs';

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf-8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      if (!env[key]) env[key] = value;
    }
  } catch {
    // .env file is optional
  }
  return env;
}

const env = loadEnv();

export const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgresql://docmem:docmem@localhost:5433/docmem',
};
