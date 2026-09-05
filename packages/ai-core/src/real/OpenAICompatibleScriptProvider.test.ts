import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptAnalysisSchema } from '../script-schema';
import { OpenAICompatibleScriptProvider } from './OpenAICompatibleScriptProvider';

function llmScriptFixture(): Record<string, unknown> {
  return {
    title: '海边的灯',
    logline: '一次告别与一次出发',
    style_anchor: '日系动画插画',
    lang: 'zh',
    characters: [
      { id: 'c1', name: '林小满', appearance: '齐肩黑发，琥珀色眼睛', personality: '倔强', voice: 'Maia' },
      { id: 'c2', name: '老周', appearance: '花白短发', personality: '沉默', voice: 'NotARealVoice' },
    ],
    episodes: [
      {
        id: 'e1',
        title: '第一集',
        scenes: [
          { id: 's1', synopsis: '小满来到港口', scene_prompt: '清晨港口，林小满望向海面' },
          { id: 's2', synopsis: '老周递来钥匙', scene_prompt: '老周伸出手' },
          { id: 's3', synopsis: '灯亮了', scene_prompt: '灯塔亮起' },
        ],
      },
    ],
  };
}

const completion = (script: unknown): unknown => ({
  choices: [{ message: { role: 'assistant', content: JSON.stringify(script) }, finish_reason: 'stop' }],
});

afterEach(() => vi.restoreAllMocks());

describe('OpenAICompatibleScriptProvider', () => {
  it('calls chat/completions with json_object mode and parses the analysis', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-ds');
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        response_format: { type: string };
        messages: { role: string; content: string }[];
      };
      expect(body.response_format.type).toBe('json_object');
      expect(body.messages[0]!.content).toContain('忠实改编');
      expect(body.messages[1]!.content).toContain('主题或文章原文：一篇短篇小说');
      return new Response(JSON.stringify(completion(llmScriptFixture())), { status: 200 });
    });
    const p = new OpenAICompatibleScriptProvider(
      { api: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds', model: 'deepseek-chat' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const analysis = await p.analyzeScript({ source: '一篇短篇小说', style: 'anime', lang: 'zh' });
    expect(() => ScriptAnalysisSchema.parse(analysis)).not.toThrow();
    expect(analysis.episodes[0]!.scenes).toHaveLength(3);
  });

  it('normalizes hallucinated voice ids to undefined', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(completion(llmScriptFixture())), { status: 200 }),
    );
    const p = new OpenAICompatibleScriptProvider(
      { api: 'openai', baseUrl: 'x', apiKey: 'k', model: 'm' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const analysis = await p.analyzeScript({ source: 'x', style: 'anime', lang: 'zh' });
    expect(analysis.characters[0]!.voice).toBe('Maia');
    expect(analysis.characters[1]!.voice).toBeUndefined();
  });

  it('passes reject_reason and title through the user prompt and strips fences', async () => {
    const fenced = '```json\n' + JSON.stringify(llmScriptFixture()) + '\n```';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      const userMsg = body.messages.find((m) => m.role === 'user')!.content;
      expect(userMsg).toContain('上一版因「violence」被驳回');
      expect(userMsg).toContain('作品名：海上的光');
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: fenced } }] }),
        { status: 200 },
      );
    });
    const p = new OpenAICompatibleScriptProvider(
      { api: 'openai', baseUrl: 'x', apiKey: 'k', model: 'm' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const analysis = await p.analyzeScript({
      source: 'x', style: 'anime', lang: 'zh', title: '海上的光', reject_reason: 'violence',
    });
    expect(analysis.title).toBe('海边的灯');
  });

  it('rejects schema-invalid LLM output', async () => {
    const bad = llmScriptFixture();
    (bad as { episodes: unknown[] }).episodes = [];
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(completion(bad)), { status: 200 }),
    );
    const p = new OpenAICompatibleScriptProvider(
      { api: 'openai', baseUrl: 'x', apiKey: 'k', model: 'm' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await expect(p.analyzeScript({ source: 'x', style: 'anime', lang: 'zh' })).rejects.toThrow();
  });
});
