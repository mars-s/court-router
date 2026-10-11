// Codex sends subagent messages as `agent_message` items whose payload sits in
// an `encrypted_content` part. GPT parents fill it with real OpenAI
// ciphertext. Claude parents (through Court) leave plain task text there, and
// GPT then fails the whole turn trying to decrypt it. Plain text is moved to an
// ordinary `input_text` part. Real ciphertext is left alone.

const OPENAI_SEALED = /^gAAAA/;

export const isOpenAISealed = (value) => typeof value === 'string' && OPENAI_SEALED.test(value);

function unsealPart(part) {
  if (part?.type !== 'encrypted_content' || typeof part.encrypted_content !== 'string') return part;
  if (isOpenAISealed(part.encrypted_content)) return part;
  return { type: 'input_text', text: part.encrypted_content };
}

// Returns the same request object when nothing needed changing.
export function unsealPlainAgentMessages(request) {
  if (!Array.isArray(request?.input)) return request;
  let changed = false;
  const input = request.input.map((item) => {
    if (item?.type !== 'agent_message' || !Array.isArray(item.content)) return item;
    const content = item.content.map(unsealPart);
    if (content.every((part, index) => part === item.content[index])) return item;
    changed = true;
    return { ...item, content };
  });
  return changed ? { ...request, input } : request;
}

// The reverse direction: a GPT parent seals its task text with real OpenAI
// ciphertext, which Claude cannot read. `reveal(item)` asks GPT to read the
// sealed message back as plain text. Unreadable blobs are left as they were.
export async function revealSealedAgentMessages(request, reveal) {
  if (!Array.isArray(request?.input) || !reveal) return request;
  let changed = false;
  const input = await Promise.all(request.input.map(async (item) => {
    if (item?.type !== 'agent_message' || !Array.isArray(item.content)) return item;
    if (!item.content.some((part) => part?.type === 'encrypted_content' && isOpenAISealed(part.encrypted_content))) return item;
    const content = await Promise.all(item.content.map(async (part) => {
      if (part?.type !== 'encrypted_content' || !isOpenAISealed(part.encrypted_content)) return part;
      const text = await reveal({ ...item, content: [part] }).catch(() => null);
      return text == null ? part : { type: 'input_text', text };
    }));
    if (content.every((part, index) => part === item.content[index])) return item;
    changed = true;
    return { ...item, content };
  }));
  return changed ? { ...request, input } : request;
}
