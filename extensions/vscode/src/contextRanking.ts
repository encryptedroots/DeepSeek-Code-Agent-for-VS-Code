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

export function findMentionedWorkspacePaths(paths: string[], prompt: string): string[] {
  const normalizedPrompt = prompt.replace(/\\/g, "/").toLowerCase();
  const basenameCounts = new Map<string, number>();
  for (const path of paths) {
    const basename = path.split("/").at(-1)?.toLowerCase();
    if (basename) basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  return paths.filter((path) => {
    const normalizedPath = path.replace(/\\/g, "/");
    if (normalizedPrompt.includes(normalizedPath.toLowerCase())) return true;
    const basename = normalizedPath.split("/").at(-1)?.toLowerCase();
    if (!basename || basenameCounts.get(basename) !== 1) return false;
    const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\w.-])${escaped}(?:$|[^\\w.-])`, "i").test(normalizedPrompt);
  });
}

export function getNewContextRequests(
  files: string[],
  searches: string[],
  seenFiles: ReadonlySet<string>,
  seenSearches: ReadonlySet<string>,
): { files: string[]; searches: string[] } {
  return {
    files: [...new Set(files.filter((file) => !seenFiles.has(file)))],
    searches: [...new Set(searches.filter((search) => !seenSearches.has(search)))],
  };
}

export function isOverviewInventoryPath(path: string): boolean {
  if (
    /(?:^|\/)(?:node_modules|vendor|dist|build|out|coverage|\.git|\.svn|\.hg|\.next|\.cache|\.turbo|target|\.venv|venv|__pycache__|\.idea|\.vscode-test)(?:\/|$)/i.test(
      path,
    )
  )
    return false;
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|.*secret.*|.*credential.*|id_rsa.*|id_ed25519.*|\.npmrc|\.pypirc|credentials)$/i.test(
      path,
    )
  )
    return false;
  if (/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(path))
    return false;
  const basename = path.split("/").pop()?.toLowerCase();
  if (
    basename &&
    /^(?:dockerfile|makefile|gemfile|rakefile|procfile|justfile|\.editorconfig|\.gitignore|\.gitattributes|\.dockerignore|\.npmrc\.example)$/.test(
      basename,
    )
  )
    return true;
  return /\.(?:c|cc|cpp|cs|css|dart|go|h|hpp|html|java|js|jsx|json|kt|md|mjs|mts|php|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|vue|svelte|astro|xml|ya?ml)$/i.test(
    path,
  );
}

export function buildOverviewInventoryText(
  workspaceName: string,
  paths: string[],
  maxBytes: number,
): { text: string; includedPaths: string[]; omittedCount: number } {
  const rootCounts = new Map<string, number>();
  for (const path of paths) {
    const root = path.includes("/") ? path.split("/")[0] : "(root)";
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  }
  const sortedRoots = [...rootCounts].sort(([left], [right]) => left.localeCompare(right));
  let text = `Workspace: ${workspaceName}\nEligible project/source files: ${paths.length}\nProject roots:\n`;
  const rootsLimit = Math.floor(maxBytes * 0.3);
  const rootsStartBytes = Buffer.byteLength(text, "utf8");
  let rootsBytes = rootsStartBytes;
  let includedRoots = 0;
  for (const [root, count] of sortedRoots) {
    const line = `${root}${root === "(root)" ? "" : "/"} (${count} project/source files)\n`;
    if (rootsBytes + Buffer.byteLength(line, "utf8") - rootsStartBytes > rootsLimit) break;
    text += line;
    rootsBytes += Buffer.byteLength(line, "utf8");
    includedRoots += 1;
  }
  if (includedRoots < sortedRoots.length) text += `[${sortedRoots.length - includedRoots} additional roots omitted]\n`;
  text += "\nProject/source file inventory:\n";
  const includedPaths: string[] = [];
  for (const path of paths) {
    const line = `${path}\n`;
    const omissionNotice = `\n[${paths.length - includedPaths.length - 1} additional inventory paths omitted by the context limit]`;
    if (Buffer.byteLength(text + line + omissionNotice, "utf8") > maxBytes) break;
    text += line;
    includedPaths.push(path);
  }
  const omittedCount = paths.length - includedPaths.length;
  if (omittedCount) text += `\n[${omittedCount} additional inventory paths omitted by the context limit]`;
  return { text: truncateUtf8(text, maxBytes), includedPaths, omittedCount };
}

export interface OverviewSourceFile {
  path: string;
  content: string;
}

export interface OverviewFileBatch {
  text: string;
  completedPaths: string[];
  parts: Array<{ path: string; part: number; total: number; content: string }>;
}

function splitUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (chunk && chunkBytes + characterBytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

export function buildOverviewFileBatches(files: OverviewSourceFile[], maxBytes: number): OverviewFileBatch[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Overview context limit must be positive.");
  const batches: OverviewFileBatch[] = [];
  let current = "";
  let currentCompletedPaths: string[] = [];
  let currentParts: OverviewFileBatch["parts"] = [];
  for (const file of files) {
    const headerReserve = Buffer.byteLength(`\n--- ${file.path} (part 999/999) ---\n`, "utf8");
    const chunks = splitUtf8(file.content, Math.max(1, maxBytes - headerReserve - 1));
    for (const [index, chunk] of chunks.entries()) {
      const header = `\n--- ${file.path}${chunks.length > 1 ? ` (part ${index + 1}/${chunks.length})` : ""} ---\n`;
      const section = `${header}${chunk}\n`;
      if (Buffer.byteLength(section, "utf8") > maxBytes)
        throw new Error(
          `Could not fit an overview content chunk for ${file.path} within the configured context limit.`,
        );
      if (current && Buffer.byteLength(current + section, "utf8") > maxBytes) {
        batches.push({ text: current, completedPaths: currentCompletedPaths, parts: currentParts });
        current = "";
        currentCompletedPaths = [];
        currentParts = [];
      }
      current += section;
      currentParts.push({ path: file.path, part: index + 1, total: chunks.length, content: chunk });
      if (index === chunks.length - 1) currentCompletedPaths.push(file.path);
    }
  }
  if (current) batches.push({ text: current, completedPaths: currentCompletedPaths, parts: currentParts });
  return batches;
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
