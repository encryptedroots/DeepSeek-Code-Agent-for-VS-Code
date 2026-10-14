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
    `User's answer:\n${reply.trim()}`,
    "Do not ask permission to inspect workspace files. If more context is needed, request specific paths using requestedFiles and propose no edits until the context is available.",
  ].join("\n\n");
}
