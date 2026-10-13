const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "change",
  "could",
  "create",
  "does",
  "file",
  "from",
  "have",
  "into",
  "make",
  "need",
  "only",
  "please",
  "should",
  "that",
  "their",
  "this",
  "with",
  "would",
]);

const GUIDANCE_FILE = /(?:^|\/)(?:agents\.md|claude\.md|copilot-instructions\.md|[^/]+\.instructions\.md)$/i;
const MANIFEST_FILE =
  /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|readme(?:\.md)?|\.eslintrc[^/]*)$/i;

export function taskTerms(task: string): string[] {
  return [...new Set(task.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 40);
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // Back up to the start of the final UTF-8 character.
    }
  }
  return "";
}

export function composeBoundedTaskContext(base: string, verification: string, maxBytes: number): string {
  const suffix = verification ? `\n\n${verification}` : "";
  const suffixLimit = verification ? Math.min(12_000, Math.floor(maxBytes * 0.25)) : 0;
  const boundedSuffix = truncateUtf8(suffix, suffixLimit);
  const baseLimit = Math.max(0, maxBytes - Buffer.byteLength(boundedSuffix, "utf8"));
  return `${truncateUtf8(base, baseLimit)}${boundedSuffix}`;
}

export function rankWorkspacePaths(paths: string[], task: string, activePath?: string): string[] {
  const terms = taskTerms(task);
  return paths
    .map((path) => {
      const lower = path.toLowerCase();
      let score = 0;
      if (GUIDANCE_FILE.test(path)) score += 300;
      if (MANIFEST_FILE.test(path)) score += 5;
      if (path === activePath) score += 50;
      for (const term of terms) {
        const stem = term.replace(/(?:ation|tion|ing|ed|es|s|e)$/, "");
        if (lower.includes(term) || (stem.length >= 4 && lower.includes(stem))) score += Math.min(term.length, 12) * 10;
      }
      if (/\.(?:test|spec)\.[^.]+$/i.test(path) && terms.some((term) => lower.includes(term))) score += 12;
      if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|h|hpp)$/i.test(path)) score += 3;
      return { path, score };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map(({ path }) => path);
}

export function relevantExcerpt(source: string, task: string, maxChars = 5_000): string {
  if (source.length <= maxChars) return source;
  const terms = taskTerms(task);
  const lines = source.split(/\r?\n/);
  if (!terms.length) return `${lines.slice(0, 60).join("\n")}\n[Excerpt truncated]`;

  const selected = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].toLowerCase();
    if (!terms.some((term) => line.includes(term))) continue;
    for (let adjacent = Math.max(0, index - 3); adjacent <= Math.min(lines.length - 1, index + 3); adjacent += 1)
      selected.add(adjacent);
  }
  const excerpts: string[] = [];
  let previous = -2;
  for (const index of [...selected].sort((left, right) => left - right)) {
    if (index > previous + 1) excerpts.push("…");
    excerpts.push(lines[index]);
    previous = index;
    if (excerpts.join("\n").length >= maxChars) break;
  }
  const notice = "\n[Relevant excerpt; request the complete file before proposing edits]";
  const excerpt = excerpts.join("\n").slice(0, Math.max(0, maxChars - notice.length));
  return excerpt ? `${excerpt}${notice}` : "[No matching lines; request the complete file before proposing edits]";
}
