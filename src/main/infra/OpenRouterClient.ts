import OpenAI from 'openai';

export type OpenAICtor = new (opts: { apiKey: string; baseURL: string }) => {
  chat: {
    completions: {
      create: (
        body: {
          model: string;
          messages: { role: 'system' | 'user'; content: string }[];
          response_format: { type: 'json_object' };
          temperature?: number;
        },
        opts?: { signal?: AbortSignal },
      ) => Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
};

export interface OpenRouterClientOptions {
  /** Override for tests. Defaults to the real OpenAI SDK constructor. */
  openaiCtor?: OpenAICtor;
}

export interface ChatJsonOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** 0..2; lower = more deterministic. Default 0.4. */
  temperature?: number;
  signal?: AbortSignal;
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Thin wrapper around the openai SDK used against OpenRouter's
 * OpenAI-compatible endpoint. Exposes a single `chatJson` method that returns
 * the parsed JSON content of the first choice. Schema validation is the
 * caller's responsibility — this layer only knows about transport + parsing.
 *
 * Caches the SDK instance per `apiKey` so repeated calls don't re-construct
 * the underlying HTTP client.
 */
export class OpenRouterClient {
  private readonly ctor: OpenAICtor;
  private readonly cache = new Map<string, InstanceType<OpenAICtor>>();

  constructor(opts: OpenRouterClientOptions = {}) {
    this.ctor = opts.openaiCtor ?? (OpenAI as unknown as OpenAICtor);
  }

  async chatJson(opts: ChatJsonOptions): Promise<unknown> {
    const sdk = this.getSdk(opts.apiKey);
    const resp = await sdk.chat.completions.create(
      {
        model: opts.model,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: opts.temperature ?? 0.4,
      },
      { signal: opts.signal },
    );
    if (!resp.choices || resp.choices.length === 0) {
      throw new Error('OpenRouter response had no choices');
    }
    const content = resp.choices[0]!.message.content;
    if (!content) {
      throw new Error('OpenRouter response had empty content');
    }
    const cleaned = stripCodeFences(content);
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`OpenRouter returned non-JSON content: ${(e as Error).message}`);
    }
  }

  private getSdk(apiKey: string): InstanceType<OpenAICtor> {
    const cached = this.cache.get(apiKey);
    if (cached) return cached;
    const sdk = new this.ctor({ apiKey, baseURL: OPENROUTER_BASE_URL });
    this.cache.set(apiKey, sdk);
    return sdk;
  }
}

/**
 * Strip a single outer ```json...``` or ```...``` markdown fence if present.
 *
 * Why: OpenRouter's `response_format: { type: 'json_object' }` is a passthrough
 * hint to the underlying provider. OpenAI models honor it natively and return
 * raw JSON. Anthropic Claude and many other models translate it into a system
 * prompt addition; they often comply but sometimes wrap the JSON in markdown
 * fences anyway (a strong bias from their training data). We strip the wrapper
 * so the same parser path works regardless of provider.
 */
function stripCodeFences(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}
