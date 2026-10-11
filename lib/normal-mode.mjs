export function restoreNormalConfig(config, saved = {}) {
  const savedModel = String(saved.model || '').replace(/^["']|["']$/g, '');
  const model = /^gpt-[\w.-]+$/.test(savedModel) ? savedModel : 'gpt-6.1-sol';
  config = config.replace(/^model\s*=.*(?:\n|$)/m, '')
    .replace(/^model_provider\s*=.*(?:\n|$)/m, '')
    .replace(/^model_catalog_json\s*=.*(?:\n|$)/m, '')
    .replace(/^openai_base_url\s*=.*(?:\n|$)/m, '')
    .replace(/\n?\[model_providers\.cliproxyapi\]\r?\n[\s\S]*?(?=\n\[|$)/, '\n');
  config = `model = ${JSON.stringify(model)}\nmodel_provider = "openai"\n${config.trimStart()}`;
  // Older chats remember this provider ID. Keep it valid, using direct ChatGPT
  // authentication and the native catalogue, even if a chat cannot be migrated.
  config = `${config.trimEnd()}\n\n[model_providers.cliproxyapi]\nname = "OpenAI"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = true\n`;
  return { config, model };
}
