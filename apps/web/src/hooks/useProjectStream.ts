import { useEffect, useState } from 'react';
import { getProject } from '../api/project-client';
import type { ProjectStatus } from '../api/project-types';

interface StreamMessage {
  projectId: string;
  type:
    | 'state'
    | 'progress'
    | 'completed'
    | 'failed'
    | 'portrait'
    | 'location'
    | 'scene_clip'
    | 'scene_narration';
  state?: string;
  progress?: { units_done: number; units_total: number };
  error?: string;
  char_id?: string;
  loc_id?: string;
  scene_id?: string;
  status?: 'generating' | 'ready' | 'failed';
}

export interface ProjectStreamResult {
  status: ProjectStatus;
  connected: boolean;
  /** 立绘生成中/失败的瞬时状态（char_id 维度） */
  portraitStates: Record<string, { phase: 'generating' | 'failed'; error?: string }>;
  /** 场景图瞬时状态（loc_id 维度） */
  locationStates: Record<string, { phase: 'generating' | 'failed'; error?: string }>;
  /** r2v 片段瞬时状态 */
  clipStates: Record<string, { phase: 'generating' | 'failed'; error?: string }>;
  /** 配音瞬时状态（片段生成时自动补齐） */
  narrationStates: Record<string, { phase: 'generating' | 'failed'; error?: string }>;
}

/**
 * 故事视频产线的 SSE 订阅：状态/进度实时更新；
 * 卡点阶段立绘/场景图逐版通知，分镜阶段片段逐场通知。
 * 单元 ready 时重新拉取完整状态（含 characters/locations/scenes/export）。
 */
export function useProjectStream(initial: ProjectStatus): ProjectStreamResult {
  const [status, setStatus] = useState(initial);
  const [connected, setConnected] = useState(false);
  const [portraitStates, setPortraitStates] = useState<ProjectStreamResult['portraitStates']>({});
  const [locationStates, setLocationStates] = useState<ProjectStreamResult['locationStates']>({});
  const [clipStates, setClipStates] = useState<ProjectStreamResult['clipStates']>({});
  const [narrationStates, setNarrationStates] = useState<ProjectStreamResult['narrationStates']>({});

  useEffect(() => {
    setStatus(initial);
    setPortraitStates({});
    setLocationStates({});
    setClipStates({});
    setNarrationStates({});
    const projectId = initial.project_id;
    const source = new EventSource(`/api/projects/${projectId}/events`);

    const fetchFullStatus = (): void => {
      void getProject(projectId)
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
      if (msg.projectId !== projectId) return;
      setConnected(true);
      if (msg.type === 'state' && msg.state) {
        const failed = msg.state.startsWith('failed_');
        setStatus((s) => ({
          ...s,
          state: msg.state!,
          error: failed ? (msg.error ?? s.error) : undefined,
        }));
        if (
          msg.state === 'awaiting_character_confirmation' ||
          msg.state === 'storyboard_review' ||
          msg.state === 'ready' ||
          msg.state === 'completed'
        ) {
          fetchFullStatus();
        }
      } else if (msg.type === 'progress' && msg.progress) {
        setStatus((s) => ({ ...s, progress: msg.progress! }));
      } else if (msg.type === 'failed') {
        setStatus((s) => ({ ...s, error: msg.error ?? s.error }));
      } else if (msg.type === 'completed') {
        fetchFullStatus();
      } else if (msg.type === 'portrait' && msg.char_id) {
        const key = msg.char_id;
        if (msg.status === 'generating') {
          setPortraitStates((m) => ({ ...m, [key]: { phase: 'generating' } }));
        } else if (msg.status === 'failed') {
          setPortraitStates((m) => ({ ...m, [key]: { phase: 'failed', error: msg.error } }));
        } else if (msg.status === 'ready') {
          setPortraitStates((m) => {
            const next = { ...m };
            delete next[key];
            return next;
          });
          fetchFullStatus();
        }
      } else if (msg.type === 'location' && msg.loc_id) {
        const key = msg.loc_id;
        if (msg.status === 'generating') {
          setLocationStates((m) => ({ ...m, [key]: { phase: 'generating' } }));
        } else if (msg.status === 'failed') {
          setLocationStates((m) => ({ ...m, [key]: { phase: 'failed', error: msg.error } }));
        } else if (msg.status === 'ready') {
          setLocationStates((m) => {
            const next = { ...m };
            delete next[key];
            return next;
          });
          fetchFullStatus();
        }
      } else if (msg.type === 'scene_clip' && msg.scene_id) {
        const key = msg.scene_id;
        if (msg.status === 'generating') {
          setClipStates((m) => ({ ...m, [key]: { phase: 'generating' } }));
        } else if (msg.status === 'failed') {
          setClipStates((m) => ({ ...m, [key]: { phase: 'failed', error: msg.error } }));
          fetchFullStatus();
        } else if (msg.status === 'ready') {
          setClipStates((m) => {
            const next = { ...m };
            delete next[key];
            return next;
          });
          fetchFullStatus();
        }
      } else if (msg.type === 'scene_narration' && msg.scene_id) {
        const key = msg.scene_id;
        if (msg.status === 'generating') {
          setNarrationStates((m) => ({ ...m, [key]: { phase: 'generating' } }));
        } else if (msg.status === 'failed') {
          setNarrationStates((m) => ({ ...m, [key]: { phase: 'failed', error: msg.error } }));
        } else if (msg.status === 'ready') {
          setNarrationStates((m) => {
            const next = { ...m };
            delete next[key];
            return next;
          });
        }
      }
    };
    source.onerror = () => setConnected(false);

    return () => {
      source.close();
      setConnected(false);
    };
    // 只按 projectId 重新订阅
  }, [initial.project_id]);

  return { status, connected, portraitStates, locationStates, clipStates, narrationStates };
}
