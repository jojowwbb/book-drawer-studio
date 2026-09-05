import type { BookStatus, CreateBookInput, ReviewCharacter } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(`API error ${status}`);
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload as T;
}

export function createBook(input: CreateBookInput): Promise<{ book_id: string }> {
  return request('POST', '/api/books', input);
}

export function getBook(id: string): Promise<BookStatus> {
  return request('GET', `/api/books/${id}`);
}

export function regeneratePage(id: string, pageId: string): Promise<{ remaining: number }> {
  return request('POST', `/api/books/${id}/pages/${pageId}/regenerate`);
}

export function resumeBook(id: string): Promise<{ state: string }> {
  return request('POST', `/api/books/${id}/resume`);
}

/** 文案编辑：改旁白/片头标题后服务端重配该页语音并重渲染片段（不重画插画） */
export function editPageText(
  id: string,
  pageId: string,
  patch: { narration?: string; cover?: { title?: string; subtitle?: string; tags?: string[] } },
): Promise<{ state: string }> {
  return request('PUT', `/api/books/${id}/pages/${pageId}/text`, patch);
}

/** 重新配音：按（修复后的）分段逐页重合成旁白，异步任务，进度经 SSE page_narration 通知 */
export function redubBook(id: string): Promise<{ state: string }> {
  return request('POST', `/api/books/${id}/redub`);
}

export function exportBook(id: string, langs?: ('zh' | 'en')[]): Promise<{ state: string }> {
  return request('POST', `/api/books/${id}/export`, langs ? { langs } : {});
}

/** 音色确认：角色列表 + 旁白音色 + 可选音色板（仅 voice_review 状态可用） */
export function getBookCharacters(id: string): Promise<{
  characters: ReviewCharacter[];
  narrator_voice: string | null;
  voices: Record<string, string>;
}> {
  return request('GET', `/api/books/${id}/characters`);
}

/** 音色确认：手动改配角色音色（voice=null 回退默认旁白音色）；key 用「旁白」改旁白音色 */
export function setBookCharacterVoices(id: string, voices: Record<string, string | null>): Promise<{ ok: boolean }> {
  return request('PUT', `/api/books/${id}/characters`, { voices });
}

/** 音色确认完毕：推进到插画与配音阶段 */
export function confirmVoices(id: string): Promise<{ state: string }> {
  return request('POST', `/api/books/${id}/confirm-voices`);
}

/** 音色试听文件（预生成静态资源，slug 规则与服务端脚本一致） */
export function voiceDemoUrl(voice: string): string {
  return `/voice-demos/${voice.trim().toLowerCase().replace(/\s+/g, '-')}.wav`;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export async function pollUntilState(
  id: string,
  states: string[],
  opts: PollOptions = {},
): Promise<BookStatus> {
  const interval = opts.intervalMs ?? 300;
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  for (;;) {
    const status = await getBook(id);
    if (states.includes(status.state)) return status;
    if (status.state.startsWith('failed_')) {
      throw new Error(`pipeline failed: ${status.error ?? status.state}`);
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${states.join('|')}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
