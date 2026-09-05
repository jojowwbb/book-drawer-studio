import { ApiError, request } from './client';
import type {
  CharacterCard,
  CreateProjectInput,
  LocationCard,
  ProjectStatus,
} from './project-types';

export function createProject(input: CreateProjectInput): Promise<{ project_id: string }> {
  return request('POST', '/api/projects', input);
}

export function getProject(id: string): Promise<ProjectStatus> {
  return request('GET', `/api/projects/${id}`);
}

/** 卡点：选定某角色某版立绘 */
export function selectPortrait(id: string, charId: string, seed: number): Promise<ProjectStatus> {
  return request('PUT', `/api/projects/${id}/characters/${charId}/select`, { seed });
}

/** 卡点：改描述重出 3 版（异步出图，完成后经 SSE portrait 事件通知） */
export function regeneratePortrait(
  id: string,
  charId: string,
  description?: { appearance?: string; costume?: string },
): Promise<{ remaining: number; characters: CharacterCard[] }> {
  return request('POST', `/api/projects/${id}/characters/${charId}/regenerate`, description ?? {});
}

/** 卡点：选定某地点某版场景图 */
export function selectLocation(id: string, locId: string, seed: number): Promise<ProjectStatus> {
  return request('PUT', `/api/projects/${id}/locations/${locId}/select`, { seed });
}

/** 卡点：改场景描述重出 3 版（异步出图，完成后经 SSE location 事件通知） */
export function regenerateLocation(
  id: string,
  locId: string,
  description?: string,
): Promise<{ remaining: number; locations: LocationCard[] }> {
  return request('POST', `/api/projects/${id}/locations/${locId}/regenerate`, description ? { description } : {});
}

/** 卡点放行：角色与场景全员已选定 → 进入分镜工作台（此后逐场手动生成） */
export function confirmCharacters(id: string): Promise<ProjectStatus> {
  return request('POST', `/api/projects/${id}/characters/confirm`);
}

export function resumeProject(id: string): Promise<{ state: string }> {
  return request('POST', `/api/projects/${id}/resume`);
}

/** 成片导出（全 AI 片段拼接 + 配音/BGM），进度经 SSE 通知 */
export function exportProject(id: string): Promise<{ state: string }> {
  return request('POST', `/api/projects/${id}/export`);
}

/** 单场视频片段：r2v 参考图直出 + 自动补配音（结果经 SSE scene_clip 事件通知） */
export function generateSceneClip(id: string, sceneId: string): Promise<unknown> {
  return request('POST', `/api/projects/${id}/scenes/${sceneId}/clip`);
}

/** 单场重画：换 seed 重跑该场 r2v（保留配音），无次数限制 */
export function regenerateScene(id: string, sceneId: string): Promise<unknown> {
  return request('POST', `/api/projects/${id}/scenes/${sceneId}/regenerate`);
}

export { ApiError };
