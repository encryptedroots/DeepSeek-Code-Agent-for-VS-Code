const SECRET_LINE =
  /^\s*["']?(?:export\s+)?(?:[\w.-]*(?:api[_-]?key|access[_-]?token|secret|password|passwd|private[_-]?key|authorization)[\w.-]*)["']?\s*[:=]\s*["']?.+$/i;
const PRIVATE_KEY_START = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

export function redactSecrets(content: string): string {
  let inPrivateKey = false;
  return content
    .split(/\r?\n/)
    .map((line) => {
      if (PRIVATE_KEY_START.test(line)) {
        inPrivateKey = true;
        return "[REDACTED PRIVATE KEY]";
      }
      if (inPrivateKey) {
        if (/-----END .*PRIVATE KEY-----/.test(line)) inPrivateKey = false;
        return "[REDACTED PRIVATE KEY]";
      }
      if (SECRET_LINE.test(line)) return "[REDACTED SECRET]";
      return line
        .replace(
          /(["']?[\w.-]*(?:api[_-]?key|access[_-]?token|secret|password|passwd|private[_-]?key|authorization)[\w.-]*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
          "$1[REDACTED]",
        )
        .replace(/https?:\/\/[^/\s:@]+:[^@\s/]+@/gi, "https://[REDACTED]@")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
        .replace(
          /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
          "[REDACTED SECRET]",
        )
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED TOKEN]");
    })
    .join("\n");
}

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[a-z]:/i.test(path))
    return false;
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}
