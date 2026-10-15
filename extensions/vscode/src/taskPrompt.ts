export function buildTaskPrompt(userPrompt: string): string {
  return userPrompt.trim();
}

export function isWorkspaceOverviewRequest(userPrompt: string): boolean {
  const overviewTerms = /\b(?:overview|file tree|project map|codebase map|workspace structure|repository structure)\b/i;
  const workspaceTerms =
    /\b(?:project|workspace|repository|repo|codebase|root|source|files?|codes?|extensions?|modules?|packages?|components?|classes?|functions?|applications?)\b/i;
  const readOnlyReviewTerms = /\b(?:review|audit|inspect|analy[sz]e|evaluate)\b/i;
  const modifyingAction = String.raw`(?:fix(?:es|ed|ing)?|implement(?:s|ed|ing)?|add(?:s|ed|ing)?|create(?:s|d|ing)?|edit(?:s|ed|ing)?|modif(?:y|ies|ied|ying)|update(?:s|d|ing)?|refactor(?:s|ed|ing)?|rewrite(?:s|d|ing)?|delete(?:s|d|ing)?|remove(?:s|d|ing)?|rename(?:s|d|ing)?|move(?:s|d|ing)?|install(?:s|ed|ing)?|upgrade(?:s|d|ing)?|change(?:s|d|ing)?|mak(?:e|es|ing)\s+(?:any\s+)?changes?)`;
  const negatedModifications = new RegExp(
    String.raw`\b(?:do\s+not|don't|dont|never|avoid|without|no\s+need\s+to|need\s+not|needn't)\s+(?:(?:please|just|actually|ever)\s+)*(?:${modifyingAction})(?:\s+(?:anything(?:\s+else)?|any\s+files?|the\s+files?|the\s+code|changes?))?(?:\s*,?\s*(?:or|and|nor)\s+(?:(?:please|just)\s+)*(?:${modifyingAction})(?:\s+(?:anything(?:\s+else)?|any\s+files?|the\s+files?|the\s+code|changes?))?)*`,
    "gi",
  );
  const affirmativeRequest = userPrompt.replace(negatedModifications, " ");
  const modifyingTerms = new RegExp(String.raw`\b${modifyingAction}\b`, "i");
  if (modifyingTerms.test(affirmativeRequest)) return false;
  return (
    (workspaceTerms.test(userPrompt) && readOnlyReviewTerms.test(userPrompt)) ||
    (overviewTerms.test(userPrompt) && workspaceTerms.test(userPrompt)) ||
    /\bwhat files\b.*\b(?:project|workspace|repository|repo|codebase)\b/i.test(userPrompt)
  );
}

export function requiresWorkspaceContext(userPrompt: string): boolean {
  const workspaceTerms =
    /\b(?:workspace|project|repository|repo|codebase|source(?:\s+code)?|extension|application|app|file|directory|folder|module|package|component|class|function|method|script|bug|error|exception|stack\s+trace|traceback|diagnostic|build|terminal|bridge|pairing|auto[\s-]?connect|fix\.py)\b/i;
  const codeTerms =
    /\b(?:code|python|typescript|javascript|html|css|json|yaml|sql|api|database|dependency|dependencies)\b/i;
  const changeActions =
    /\b(?:fix|implement|create|add|edit|modify|update|refactor|rewrite|remove|delete|rename|move|change|build|run|test|install|upgrade|debug)\b/i;
  const testTask = /\b(?:run|execute|fix|create|add|update|debug)\b.{0,50}\b(?:tests?|specs?)\b/i;
  return (
    workspaceTerms.test(userPrompt) ||
    (codeTerms.test(userPrompt) && changeActions.test(userPrompt)) ||
    testTask.test(userPrompt)
  );
}

export function isMissingWorkspaceContextResponse(response: string): boolean {
  const normalized = response.replace(/[’‘]/g, "'");
  const inability = /\b(?:do not|don't|dont|cannot|can't|unable to)\b/i;
  const resource =
    /\b(?:access|read|inspect|view|see|open|retrieve)\b.{0,100}\b(?:workspace|file\s*system|files?|directories|folders)\b|\b(?:do not|don't|dont|cannot|can't|unable to)\s+have\b.{0,80}\b(?:workspace|file\s*system|files?|directories|folders)\b|\b(?:access|read|inspect|view|see|open|retrieve)\b.{0,100}\b[\w.-]+\.(?:txt|md|json|ya?ml|toml|ini|cfg|conf|py|ts|tsx|js|jsx|css|html|xml|sql|sh|bat|ps1)\b/i;
  const unavailable =
    /\b(?:file|path)\b.{0,100}\b(?:isn't|is not|doesn't exist|does not exist|not present|missing|unavailable|outside (?:the )?workspace)\b|\b(?:isn't|is not|doesn't exist|does not exist|not present|missing|unavailable)\b.{0,80}\b(?:workspace|file|path)\b/i;
  return (
    (inability.test(normalized) && resource.test(normalized)) ||
    (inability.test(normalized) && unavailable.test(normalized))
  );
}

export function isSpecificFileContentsRequest(response: string): boolean {
  const normalized = response.replace(/[’‘]/g, "'");
  const asksForContents =
    /\b(?:paste|provide|share|send|supply)\b.{0,100}\b(?:contents?|text|information|details)\b|\b(?:contents?|text|information|details)\b.{0,100}\b(?:paste|provide|share|send|supply)\b/i;
  const identifiesMissingFile =
    /\b(?:file|path)\b.{0,100}\b(?:isn't|is not|doesn't exist|does not exist|not present|missing|unavailable|outside (?:the )?workspace)\b|\b(?:isn't|is not|doesn't exist|does not exist|not present|missing|unavailable)\b.{0,80}\b(?:workspace|file|path)\b/i;
  return asksForContents.test(normalized) && identifiesMissingFile.test(normalized);
}

export interface PendingClarification {
  task: string;
  question: string;
}

export function isClarificationConfirmation(reply: string): boolean {
  const normalized = reply
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");
  return (
    normalized.split(/\s+/).length <= 12 &&
    /^(?:yes|yeah|yep|sure|okay|ok|please do|go ahead|continue|proceed)\b/.test(normalized)
  );
}

export function isClarificationRejection(reply: string): boolean {
  const normalized = reply
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");
  return normalized.split(/\s+/).length <= 12 && /^(?:no|nope|nah|not yet|don't|do not|stop|cancel)\b/.test(normalized);
}

export function buildClarificationFollowUpPrompt(clarification: PendingClarification, reply: string): string {
  return [
    "Continue the user's original task using their clarification below; do not treat the clarification as a separate task.",
    `Original user task:\n${clarification.task}`,
    `Assistant's clarification question:\n${clarification.question}`,
    `User's answer and any supplied file contents or missing details:\n${reply.trim()}`,
    "Treat any file contents pasted in the user's answer as the requested workspace context for this task, even if that file is not present in the workspace. Use those contents directly; do not ask for them again.",
    "Do not ask permission to inspect workspace files. If more context is needed, request specific paths using requestedFiles and propose no edits until the context is available.",
  ].join("\n\n");
}
