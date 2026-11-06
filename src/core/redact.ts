/**
 * Secret scrubbing for anything that leaves the process boundary toward a human:
 * output-channel lines, error details, and the support bundle. Catches JWTs (access
 * tokens and Security Portal PATs are both JWTs), Authorization header values, and
 * base64 basic-auth blobs long enough to be credentials.
 */

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_HEADER_PATTERN = /((?:authorization|proxy-authorization)"?\s*[:=]\s*"?)(?:basic|bearer)?\s*[A-Za-z0-9+/_.=-]{16,}/gi;
const BEARER_BASIC_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9+/_.=-]{16,}/gi;

// Defense-in-depth for secrets that are NOT JWTs and so slip past the patterns above:
// opaque tokens (refresh tokens, authorization codes), client secrets, and password-style
// key/value pairs that can appear in logged error bodies, pasted sessions, or engine commands.
// Catch them by key: `key=value`, `"key":"value"`, or `key: value`, redacting the value.
// Whitespace runs are BOUNDED ({0,4}) on purpose — an unbounded `\s*` on either side of the
// separator backtracks quadratically on server-controlled input and can freeze the UI thread.
const SECRET_KV_PATTERN =
  /\b(refresh_token|access_token|client_secret|password|passwd|pwd|secret|api[_-]?key)(\s{0,4}["']?\s{0,4}[:=]\s{0,4}["']?)([^\s"'&,}]{4,})/gi;
// OAuth authorization codes are long and URL-safe; scope tightly so plain "code: 5" is left.
const AUTH_CODE_PATTERN = /\b(code)(\s{0,4}["']?\s{0,4}[:=]\s{0,4}["']?)([A-Za-z0-9._~+/=-]{16,})/gi;
// Credentials embedded in a URL: `scheme://user:pass@` (password) or `scheme://token@` (userinfo
// with no colon — a token-as-username). Both forms appear in host addresses / engine commands.
const URL_USERINFO_PW_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:)([^/@\s]+)(@)/gi;
const URL_USERINFO_TOKEN_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]{8,})(@)/gi;
// Command-line password flags in a space-joined string (the element-wise form for argv arrays
// is redactArgvSecrets below).
const CLI_PASSWORD_PATTERN = /(--(?:password|pass|pwd)[=\s]+|sshpass\s+-p\s*)(\S+)/gi;

export const REDACTED = "«redacted»";

export function redactSecrets(text: string): string {
  return text
    .replace(JWT_PATTERN, REDACTED)
    .replace(AUTH_HEADER_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER_BASIC_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(SECRET_KV_PATTERN, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(AUTH_CODE_PATTERN, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(URL_USERINFO_PW_PATTERN, (_m, prefix: string, _pw: string, at: string) => `${prefix}${REDACTED}${at}`)
    .replace(URL_USERINFO_TOKEN_PATTERN, (_m, prefix: string, _tok: string, at: string) => `${prefix}${REDACTED}${at}`)
    .replace(CLI_PASSWORD_PATTERN, (_m, flag: string) => `${flag}${REDACTED}`);
}

const ARGV_PASSWORD_FLAG = /^(--password|--pass|--pwd|--token|--secret)$/i;
const ARGV_PASSWORD_INLINE = /^(--(?:password|pass|pwd|token|secret))=(.+)$/i;

/**
 * Redact secrets in a command-line argument VECTOR, where each token is a separate element
 * (`["sshpass","-p","pw"]`) so the string patterns above — which look for `flag value` in one
 * string — never fire. The support bundle serializes engineCommand arrays as JSON, so their
 * argv passwords must be scrubbed element-wise before serialization. Bare `-p` is left alone
 * (it is a docker port flag far more often than a password) except in the `sshpass -p` form.
 */
export function redactArgvSecrets(args: readonly string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const token = out[i]!;
    const inline = ARGV_PASSWORD_INLINE.exec(token);
    if (inline) {
      out[i] = `${inline[1]}=${REDACTED}`;
      continue;
    }
    if (/^sshpass$/i.test(token) && out[i + 1] === "-p" && i + 2 < out.length) {
      out[i + 2] = REDACTED;
      i += 2;
      continue;
    }
    if (ARGV_PASSWORD_FLAG.test(token) && i + 1 < out.length) {
      out[i + 1] = REDACTED;
      i += 1;
    }
  }
  return out;
}
