import type { BookFormat, BookLang, ExportArtifact, ProjectStyle } from './types';

/** 角色立绘版本（同描述不同 seed 出多版供三选一） */
export interface PortraitVersion {
  seed: number;
  url?: string;
  failed?: boolean;
  error?: string;
}

export interface CharacterCard {
  id: string;
  name: string;
  appearance: string;
  costume?: string;
  personality: string;
  voice?: string;
  versions: PortraitVersion[];
  selected?: number;
}

/** 场景资产卡（与角色立绘对称：每地点 3 版场景图供选择，r2v 参考图） */
export interface LocationCard {
  id: string;
  name: string;
  description: string;
  versions: PortraitVersion[];
  selected?: number;
}

/** 单场分镜产物清单 */
export interface SceneManifest {
  scene_id: string;
  /** r2v 视频片段（参考图=选定场景图+角色立绘，直接出片，无关键帧中间层） */
  clip_url?: string;
  clip_duration_ms?: number;
  clip_failed?: boolean;
  narration_url?: string;
  narration_duration_ms?: number;
  seed: number;
}

export interface ProjectProgress {
  units_done: number;
  units_total: number;
}

/** 剧本单场内容（script.json 的场次，工作台展示脚本用） */
export interface ScriptSceneContent {
  id: string;
  title?: string;
  synopsis: string;
  dialogues: { speaker: string; line: string }[];
  /** 本场地点（引用 locations[].id） */
  location_id?: string;
  scene_prompt: string;
  camera?: string;
  narration?: string;
}

/** 场景资产卡（同一地点跨场共用一份描述，防场景幻觉） */
export interface ScriptLocationContent {
  id: string;
  name: string;
  description: string;
}

/** GET /api/projects/:id 附带的剧本原文 */
export interface ProjectScript {
  title: string;
  logline?: string;
  style_anchor: string;
  lang: string;
  locations?: ScriptLocationContent[];
  episodes: { id: string; title: string; scenes: ScriptSceneContent[] }[];
}

export interface ProjectStatus {
  project_id: string;
  title?: string;
  /** 视频风格预设；旧项目可能存绘本画风 id，展示时按未知风格回退 */
  style: string;
  format: BookFormat;
  lang: BookLang;
  state: string;
  progress: ProjectProgress;
  error?: string;
  characters: CharacterCard[];
  /** 场景资产卡（旧项目缺省） */
  locations?: LocationCard[];
  scenes: SceneManifest[];
  export?: ExportArtifact;
  capabilities?: { ai_video: boolean };
  /** 剧本原文（分析完成前缺省） */
  script?: ProjectScript;
}

export interface CreateProjectInput {
  source: string;
  title?: string;
  style: ProjectStyle;
  format: BookFormat;
  lang: BookLang;
  episode_count?: number;
}
