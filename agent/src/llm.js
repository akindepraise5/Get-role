// One adapter over eight model providers. Whichever API key is in .env wins,
// free tiers first. Every provider here speaks one of three wire formats.
//
// Model ids move fast — if a provider rejects the default below, set
// "llm": { "provider": "<name>", "model": "<their current id>" } in search.config.json.

export const PROVIDERS = {
  // --- genuinely free tiers ---
  groq: {
    free: true,
    label: "Groq",
    env: "GROQ_API_KEY",
    kind: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    json: true,
  },
  gemini: {
    free: true,
    label: "Google Gemini",
    env: "GEMINI_API_KEY",
    kind: "gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    model: "gemini-2.0-flash",
  },
  openrouter: {
    free: true,
    label: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    kind: "openai",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct:free",
  },
  cerebras: {
    free: true,
    label: "Cerebras",
    env: "CEREBRAS_API_KEY",
    kind: "openai",
    url: "https://api.cerebras.ai/v1/chat/completions",
    model: "llama-3.3-70b",
    json: true,
  },

  // --- paid ---
  deepseek: {
    free: false,
    label: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    kind: "openai",
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    json: true,
  },
  openai: {
    free: false,
    label: "OpenAI (ChatGPT)",
    env: "OPENAI_API_KEY",
    kind: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    json: true,
  },
  xai: {
    free: false,
    label: "xAI (Grok)",
    env: "XAI_API_KEY",
    kind: "openai",
    url: "https://api.x.ai/v1/chat/completions",
    model: "grok-3-mini",
    json: true,
  },
  anthropic: {
    free: false,
    label: "Anthropic (Claude)",
    env: "ANTHROPIC_API_KEY",
    kind: "anthropic",
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-opus-5",
  },
};

// Order the auto-picker walks: free tiers first, cheapest paid next.
const ORDER = ["groq", "gemini", "cerebras", "openrouter", "deepseek", "openai", "xai", "anthropic"];

export function pickProvider(cfg) {
  const want = (cfg && cfg.provider) || "auto";
  if (want !== "auto") {
    const p = PROVIDERS[want];
    if (!p) throw new Error(`Unknown provider "${want}". One of: ${Object.keys(PROVIDERS).join(", ")}`);
    if (!process.env[p.env]) throw new Error(`${p.label} selected but ${p.env} is not set in .env`);
    return { key: want, ...p, model: (cfg && cfg.model) || p.model };
  }
  for (const name of ORDER) {
    if (process.env[PROVIDERS[name].env]) {
      const p = PROVIDERS[name];
      return { key: name, ...p, model: (cfg && cfg.model) || p.model };
    }
  }
  return null;
}

/** Parses JSON out of a model reply that may be fenced or padded with prose. */
export function looseJSON(text) {
  const t = String(text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  try {
    return JSON.parse(body);
  } catch {}
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
  if (start > -1 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {}
  }
  throw new Error("model did not return parseable JSON");
}

async function post(url, headers, body, timeout = 120000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Sends one prompt, returns the reply text. */
export async function ask(provider, prompt) {
  const key = process.env[provider.env];

  if (provider.kind === "openai") {
    const body = {
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    };
    if (provider.json) body.response_format = { type: "json_object" };
    const out = await post(provider.url, { authorization: `Bearer ${key}` }, body);
    const msg = out.choices && out.choices[0] && out.choices[0].message;
    return (msg && msg.content) || "";
  }

  if (provider.kind === "gemini") {
    const url = provider.url.replace("{model}", provider.model) + `?key=${key}`;
    const out = await post(url, {}, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    });
    const parts = out.candidates && out.candidates[0] && out.candidates[0].content
      ? out.candidates[0].content.parts || []
      : [];
    return parts.map((p) => p.text || "").join("");
  }

  if (provider.kind === "anthropic") {
    const out = await post(
      provider.url,
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model: provider.model, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }
    );
    if (out.stop_reason === "refusal") {
      throw new Error("Claude declined this request" + (out.stop_details ? ` (${out.stop_details.category})` : ""));
    }
    return (out.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  throw new Error(`Unsupported provider kind: ${provider.kind}`);
}
