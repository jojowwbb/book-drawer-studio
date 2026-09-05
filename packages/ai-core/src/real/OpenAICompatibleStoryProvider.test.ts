import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorySchema } from '../story-schema';
import { OpenAICompatibleStoryProvider } from './OpenAICompatibleStoryProvider';

function llmStoryFixture(theme: string, pages = 4): Record<string, unknown> {
  return {
    title: `${theme} 的月光冒险`,
    age_hint: '3-6',
    style_anchor: '暖色水彩手绘，柔和笔触，纸张纹理，儿童绘本风',
    lang: 'zh',
    characters: [
      { name: '小暖', appearance_desc: '圆滚滚的小熊，暖棕色绒毛，红色围巾' },
      { name: '萤火虫灯灯', appearance_desc: '一盏发着暖黄光的萤火虫，翅膀透明' },
    ],
    pages: Array.from({ length: pages }, (_, i) => ({
      page_id: `p${i + 1}`,
      page_text: `第 ${i + 1} 页的正文。`,
      narration: `第 ${i + 1} 页的旁白。`,
      scene_desc: `月光下的森林空地，第 ${i + 1} 幕`,
      characters: i % 2 === 0 ? ['小暖'] : ['小暖', '萤火虫灯灯'],
      emotion: ['calm', 'wonder', 'joyful', 'sleepy'][i % 4],
      is_climax: i === pages - 3,
      fx_hints: { camera: 'ken_burns_in', subjects: ['breathe'], ambient: 'stars_twinkle' },
    })),
  };
}

const completion = (story: unknown): unknown => ({
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(story) }, finish_reason: 'stop' }],
  usage: {},
});

afterEach(() => vi.restoreAllMocks());

describe('OpenAICompatibleStoryProvider', () => {
  it('calls chat/completions with model, bearer auth and json_object mode', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-ds');
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        response_format: { type: string };
        messages: { role: string; content: string }[];
      };
      expect(body.model).toBe('deepseek-chat');
      expect(body.response_format.type).toBe('json_object');
      expect(body.messages[0]!.role).toBe('system');
      // 核心思想幕规则必须在 system prompt 中
      expect(body.messages[0]!.content).toContain('核心思想');
      expect(body.messages[1]!.role).toBe('user');
      return new Response(JSON.stringify(completion(llmStoryFixture('孩子怕黑'))), { status: 200 });
    });
    const p = new OpenAICompatibleStoryProvider(
      { api: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds', model: 'deepseek-chat' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const story = await p.generateStory({
      theme: '孩子怕黑', style: 'watercolor', lang: 'zh', page_count: 4,
    });
    expect(story.pages).toHaveLength(4);
    expect(() => StorySchema.parse(story)).not.toThrow();
  });

  it('passes reject_reason through and strips markdown fences before parsing', async () => {
    const fenced = '```json\n' + JSON.stringify(llmStoryFixture('怕黑 v2', 3)) + '\n```';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      const userMsg = body.messages.find((m) => m.role === 'user')!.content;
      expect(userMsg).toContain('上一版因「too scary」被驳回');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: fenced }, finish_reason: 'stop' }],
        }),
        { status: 200 },
      );
    });
    const p = new OpenAICompatibleStoryProvider(
      { api: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const story = await p.generateStory({
      theme: '怕黑 v2', style: 'watercolor', lang: 'zh', page_count: 3, reject_reason: 'too scary',
    });
    expect(story.pages).toHaveLength(3);
  });

  it('asks for free-form pacing when page_count is omitted', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      const userMsg = body.messages.find((m) => m.role === 'user')!.content;
      expect(userMsg).toContain('按内容量自适应分幕');
      expect(userMsg).not.toContain('页数：12');
      return new Response(JSON.stringify(completion(llmStoryFixture('自由分幕', 5))), { status: 200 });
    });
    const p = new OpenAICompatibleStoryProvider(
      { api: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const story = await p.generateStory({ theme: '自由分幕', style: 'watercolor', lang: 'zh' });
    expect(story.pages).toHaveLength(5);
  });

  it('repairs segments that dropped mid-dialogue narration lines', async () => {
    // AI 分段漏掉「阿牛却摆摆手说：」这类过渡句：provider 应按 narration 逐字补回
    const story = llmStoryFixture('补回旁白', 3);
    const p3 = (story.pages as Record<string, unknown>[])[2]!;
    p3['narration'] = '王爷爷说：快修羊圈。阿牛说：不迟不迟。';
    p3['segments'] = [
      { speaker: '旁白', text: '王爷爷说：' },
      { speaker: '王爷爷', text: '快修羊圈。' },
      { speaker: '阿牛', text: '不迟不迟。' },
    ];
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(completion(story)), { status: 200 }),
    );
    const p = new OpenAICompatibleStoryProvider(
      { api: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const out = await p.generateStory({ theme: '补回旁白', style: 'watercolor', lang: 'zh', page_count: 3 });
    const segs = out.pages[2]!.segments!;
    expect(segs.map((s) => s.text).join('')).toBe('王爷爷说：快修羊圈。阿牛说：不迟不迟。');
    expect(segs.some((s) => s.speaker === '旁白' && s.text === '阿牛说：')).toBe(true);
  });

  it('rejects schema-invalid LLM output instead of leaking it downstream', async () => {
    const bad = llmStoryFixture('x', 2); // 页数 < 3，schema 应拒绝
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(completion(bad)), { status: 200 }),
    );
    const p = new OpenAICompatibleStoryProvider(
      { api: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await expect(
      p.generateStory({ theme: 'x', style: 'watercolor', lang: 'zh', page_count: 2 }),
    ).rejects.toThrow();
  });
});
