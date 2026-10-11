// Context handoff between models in one chat, following T3 Code: one
// model's sealed context is never replayed to another. The model that made it
// writes a plain summary instead.

const LEGACY_PREFIX = 'court-compaction:v1:';

export const HANDOFF_PROMPT = 'Write a handoff summary of this conversation for the model that will continue it. Include the user\'s goals and constraints, decisions made, work done, current state, files and commands involved, and next steps. Keep exact names, paths and values. Reply with the summary only.';

// Codex asks for compaction with a turn that ends in this item.
export const wantsCompaction = (request) => Array.isArray(request?.input) && request.input.at(-1)?.type === 'compaction_trigger';

export const handoffMessage = (summary) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Summary of the earlier conversation:\n\n${summary}` }] });

// Older Court versions stored Router compaction as a readable summary.
export const isCourtCompaction = (item) => item?.type === 'compaction' && typeof item.encrypted_content === 'string' && item.encrypted_content.startsWith(LEGACY_PREFIX);

export function summaryMessage(item) {
  const { summary } = JSON.parse(Buffer.from(item.encrypted_content.slice(LEGACY_PREFIX.length), 'base64').toString('utf8'));
  return handoffMessage(summary);
}
