import axios from 'axios';

export const DEBUG_DETAIL_LIMIT = 500;

/** Formats a DevRev (axios) error as `METHOD path [status] message` without request headers or bodies. */
export const formatDevRevError = (error: unknown): string => {
  if (!axios.isAxiosError(error)) return error instanceof Error ? error.message : 'unknown error';
  const data = error.response?.data as
    | { debug_message?: string; detail?: string; message?: string; type?: string }
    | undefined;
  const details = [data?.message, data?.detail, data?.debug_message, data?.type].filter(
    (value, index, values): value is string => !!value && values.indexOf(value) === index
  );
  const method = error.config?.method?.toUpperCase() ?? 'REQUEST';
  const path = error.config?.url ?? 'unknown-endpoint';
  const status = error.response?.status ? ` [${error.response.status}]` : '';
  const description = details.length ? details.join(' | ') : error.message;
  return `${method} ${path}${status} ${description}`;
};

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Signed URL query strings.
  [/(https?:\/\/[^\s?"']+)\?[^\s"']+/gi, `$1?${REDACTED}`],
  // Authorization headers and bearer tokens.
  [/\b(bearer|basic)\s+[^\s"',]+/gi, `$1 ${REDACTED}`],
  // key=value / "key": "value" pairs for secret-looking names.
  [
    /\b([\w-]*(?:token|secret|password|authorization|api[_-]?key|access[_-]?key|signature|credential)[\w-]*)("?\s*[:=]\s*"?)[^\s"',}&]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Slack tokens.
  [/\bxox[a-z]-[A-Za-z0-9-]+/gi, REDACTED],
  // JWTs (DevRev PATs and act-as tokens).
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
  // Any other long opaque credential-like run.
  [/[A-Za-z0-9_\-+=]{40,}/g, REDACTED],
];

/** Removes anything that looks like a credential. */
export const redactSecrets = (text: string, secrets: Array<string | undefined> = []): string => {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) result = result.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
};

export const isDebugErrorsEnabled = (value: unknown): boolean => String(value ?? '').toLowerCase() === 'true';

/** Builds the QA-only debug suffix for a Slack failure reply: failing step plus a redacted, trimmed error. */
export const formatDebugDetail = (step: string, detail: string, secrets: Array<string | undefined> = []): string => {
  const redacted = redactSecrets(detail, secrets).replace(/\s+/g, ' ').trim();
  const trimmed = redacted.length > DEBUG_DETAIL_LIMIT ? `${redacted.slice(0, DEBUG_DETAIL_LIMIT - 1)}…` : redacted;
  return `[debug] step=${step}: ${trimmed || 'no detail'}`;
};
