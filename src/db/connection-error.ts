// Classifies whether an error is a failure to REACH the DB server, as opposed to a
// query/auth/schema error against a server that was reached. The single source of truth
// for "the pgvector container is unreachable" across the healthcheck and the CLI.

// libpq/node network failure codes that mean "never got a usable connection".
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// Message fragments the pg driver uses for startup-time connection failures that do not
// carry one of the codes above.
const CONNECT_MESSAGES = [
  'connection terminated',
  'timeout expired',
  'terminating connection due to administrator command',
];

export function isConnectionRefused(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECT_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string') {
    const lower = message.toLowerCase();
    return CONNECT_MESSAGES.some(fragment => lower.includes(fragment));
  }
  return false;
}
