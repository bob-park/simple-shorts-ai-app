import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenRouterClient } from './OpenRouterClient';

describe('OpenRouterClient', () => {
  let createCompletion: ReturnType<typeof vi.fn>;
  let openaiCtor: ReturnType<typeof vi.fn>;
  let client: OpenRouterClient;

  beforeEach(() => {
    createCompletion = vi.fn();
    openaiCtor = vi.fn(() => ({
      chat: { completions: { create: createCompletion } },
    }));
    client = new OpenRouterClient({ openaiCtor: openaiCtor as never });
  });

  it('constructs the SDK with OpenRouter baseURL and the provided key', async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: '{"highlights":[]}' } }],
    });
    await client.chatJson({
      apiKey: 'sk-or-v1-abc',
      model: 'anthropic/claude-sonnet-4.5',
      systemPrompt: 'sys',
      userPrompt: 'user',
    });
    expect(openaiCtor).toHaveBeenCalledTimes(1);
    const args = openaiCtor.mock.calls[0]![0];
    expect(args.apiKey).toBe('sk-or-v1-abc');
    expect(args.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('sends a chat completion with response_format json_object and returns parsed JSON', async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: '{"highlights":[{"start_sec":0,"end_sec":5,"title":"t","hook":"h"}]}' } }],
    });
    const result = await client.chatJson({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 'sys',
      userPrompt: 'user',
    });
    expect(createCompletion).toHaveBeenCalledTimes(1);
    const opts = createCompletion.mock.calls[0]![0];
    expect(opts.model).toBe('m');
    expect(opts.response_format).toEqual({ type: 'json_object' });
    expect(opts.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ]);
    expect(result).toEqual({
      highlights: [{ start_sec: 0, end_sec: 5, title: 't', hook: 'h' }],
    });
  });

  it('forwards an AbortSignal to the SDK call', async () => {
    createCompletion.mockResolvedValue({ choices: [{ message: { content: '{}' } }] });
    const controller = new AbortController();
    await client.chatJson({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      signal: controller.signal,
    });
    const opts = createCompletion.mock.calls[0]![1];
    expect(opts.signal).toBe(controller.signal);
  });

  it('throws a descriptive error when the response has no choices', async () => {
    createCompletion.mockResolvedValue({ choices: [] });
    await expect(client.chatJson({ apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(
      /no choices/i,
    );
  });

  it('throws when the message content is not valid JSON', async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: 'not json at all' } }],
    });
    await expect(client.chatJson({ apiKey: 'k', model: 'm', systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(
      /json/i,
    );
  });

  it('caches the SDK instance per apiKey (does not reconstruct on identical key)', async () => {
    createCompletion.mockResolvedValue({ choices: [{ message: { content: '{}' } }] });
    await client.chatJson({ apiKey: 'k1', model: 'm', systemPrompt: 's', userPrompt: 'u' });
    await client.chatJson({ apiKey: 'k1', model: 'm', systemPrompt: 's', userPrompt: 'u' });
    expect(openaiCtor).toHaveBeenCalledTimes(1);
    await client.chatJson({ apiKey: 'k2', model: 'm', systemPrompt: 's', userPrompt: 'u' });
    expect(openaiCtor).toHaveBeenCalledTimes(2);
  });
});
