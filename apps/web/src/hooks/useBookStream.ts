import { useEffect, useState } from 'react';
import { getBook } from '../api/client';
import type { BookProgress, BookStatus } from '../api/types';

interface StreamMessage {
  bookId: string;
  type: 'state' | 'progress' | 'completed' | 'failed' | 'page_clip' | 'page_narration';
  state?: string;
  progress?: BookProgress;
  error?: string;
  page_id?: string;
  status?: 'generating' | 'ready' | 'failed';
}

export interface BookStreamResult {
  status: BookStatus;
  connected: boolean;
  /** 逐页旁白合成状态（管线自动合成/重新配音，来自 SSE page_narration 事件） */
  narrationStates: Record<string, { phase: 'generating' | 'failed'; error?: string }>;
  /** 逐页旁白版本号（每次合成完成 +1，用作回放 URL 的 cache-buster） */
  narrationVersions: Record<string, number>;
  /** 逐页片段渲染完成版本号（page_clip ready 时 +1，文案编辑后据此重载 spec） */
  clipVersions: Record<string, number>;
}

export function useBookStream(initial: BookStatus): BookStreamResult {
  const [status, setStatus] = useState(initial);
  const [connected, setConnected] = useState(false);
  const [narrationStates, setNarrationStates] = useState<Record<string, { phase: 'generating' | 'failed'; error?: string }>>({});
  const [narrationVersions, setNarrationVersions] = useState<Record<string, number>>({});
  const [clipVersions, setClipVersions] = useState<Record<string, number>>({});

  useEffect(() => {
    setStatus(initial);
    setNarrationStates({});
    setNarrationVersions({});
    const bookId = initial.book_id;
    const source = new EventSource(`/api/books/${bookId}/events`);

    const fetchFullStatus = (): void => {
      void getBook(bookId)
        .then((s) => setStatus(s))
        .catch(() => undefined);
    };

    source.onopen = () => setConnected(true);
    source.onmessage = (ev: MessageEvent<string>) => {
      let msg: StreamMessage;
      try {
        msg = JSON.parse(ev.data) as StreamMessage;
      } catch {
        return;
      }
      if (msg.bookId !== bookId) return;
      setConnected(true);
      if (msg.type === 'state' && msg.state) {
        const failed = msg.state.startsWith('failed_');
        setStatus((s) => ({
          ...s,
          state: msg.state!,
          error: failed ? (msg.error ?? s.error) : undefined,
        }));
        // voice_review 需要角色列表、ready/completed 需要 preview/exports/clips：重新拉取完整状态
        if (msg.state === 'ready' || msg.state === 'completed' || msg.state === 'voice_review') {
          fetchFullStatus();
        }
      } else if (msg.type === 'progress' && msg.progress) {
        setStatus((s) => ({ ...s, progress: msg.progress! }));
      } else if (msg.type === 'failed') {
        // 状态由随前的 state 事件决定（生成失败 failed_* / 导出失败回 ready），
        // 这里只负责记录错误信息
        setStatus((s) => ({ ...s, error: msg.error ?? s.error }));
      } else if (msg.type === 'completed') {
        fetchFullStatus();
      } else if (msg.type === 'page_clip' && msg.page_id) {
        // canvas 片段渲染完成（文案编辑后重渲染）：递增版本号供前端重载 spec
        const pageId = msg.page_id;
        if (msg.status === 'ready') {
          setClipVersions((m) => ({ ...m, [pageId]: (m[pageId] ?? 0) + 1 }));
          fetchFullStatus();
        }
      } else if (msg.type === 'page_narration' && msg.page_id) {
        // 旁白合成：generating（重新配音进行中）/ ready（清掉进行中标记）/ failed（逐页提示）
        const pageId = msg.page_id;
        if (msg.status === 'generating') {
          setNarrationStates((m) => ({ ...m, [pageId]: { phase: 'generating' } }));
        } else if (msg.status === 'failed') {
          setNarrationStates((m) => ({ ...m, [pageId]: { phase: 'failed', error: msg.error } }));
        } else if (msg.status === 'ready') {
          setNarrationStates((m) => {
            const next = { ...m };
            delete next[pageId];
            return next;
          });
          setNarrationVersions((m) => ({ ...m, [pageId]: (m[pageId] ?? 0) + 1 }));
          fetchFullStatus();
        }
      }
    };
    source.onerror = () => setConnected(false);

    return () => {
      source.close();
      setConnected(false);
    };
    // initial 对象可能是父组件任意来源的新对象，只按 bookId 重新订阅
  }, [initial.book_id]);

  return { status, connected, narrationStates, narrationVersions, clipVersions };
}
