// Claude replies can carry Anthropic citation annotations such as
// `web_search_result_location`. The OpenAI Responses API accepts only
// `file_citation`, `url_citation` and `container_file_citation`, and rejects
// the whole request otherwise, so a chat that once used Claude web search
// fails on every GPT turn. Convert URL-bearing citations to `url_citation`
// and drop the rest.

const OPENAI_ANNOTATION_TYPES = new Set(['file_citation', 'url_citation', 'container_file_citation']);

function toUrlCitation(annotation, text) {
  const url = annotation.url ?? annotation.uri;
  if (typeof url !== 'string' || !url) return null;
  const length = typeof text === 'string' ? text.length : 0;
  const start = Number.isInteger(annotation.start_index) ? Math.min(annotation.start_index, length) : 0;
  const end = Number.isInteger(annotation.end_index) ? Math.min(Math.max(annotation.end_index, start), length) : start;
  return {
    type: 'url_citation',
    url,
    title: typeof annotation.title === 'string' ? annotation.title : url,
    start_index: start,
    end_index: end
  };
}

function cleanPart(part) {
  if (!part || !Array.isArray(part.annotations)) return part;
  let changed = false;
  const annotations = [];
  for (const annotation of part.annotations) {
    if (OPENAI_ANNOTATION_TYPES.has(annotation?.type)) { annotations.push(annotation); continue; }
    changed = true;
    const converted = toUrlCitation(annotation ?? {}, part.text);
    if (converted) annotations.push(converted);
  }
  return changed ? { ...part, annotations } : part;
}

// Returns the same request object when nothing needed changing.
export function normaliseAnnotations(request) {
  if (!Array.isArray(request?.input)) return request;
  let changed = false;
  const input = request.input.map((item) => {
    if (!Array.isArray(item?.content)) return item;
    const content = item.content.map(cleanPart);
    if (content.every((part, index) => part === item.content[index])) return item;
    changed = true;
    return { ...item, content };
  });
  return changed ? { ...request, input } : request;
}
