import type { Lang, StyleId } from '@pb/ai-core';
import type { ProjectCounters, ProjectState } from './project-state-machine';
import type { AssetStore } from './asset-store';
import type { ExportArtifact } from './book-repo';

/** 角色定制卡：立绘版本池 + 用户选定项（卡点环节的交互对象） */
export interface PortraitVersion {
  /** 生成立绘用的 seed（同描述不同 seed 出多版） */
  seed: number;
  /** 立绘 PNG 的 URL；审核/生成全失败的版本没有 url */
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
  /** 立绘版本（每轮 3 版；改描述重生成会追加新一轮） */
  versions: PortraitVersion[];
  /** 用户选定的版本 seed；卡点放行前必须非空 */
  selected?: number;
}

/** 场景资产卡：与角色立绘对称，每地点 3 版场景图供选择（r2v 参考图） */
export interface LocationCard {
  id: string;
  name: string;
  description: string;
  /** 场景图版本（每轮 3 版；改描述重生成会追加新一轮） */
  versions: PortraitVersion[];
  /** 用户选定的版本 seed */
  selected?: number;
}

/** 单场分镜产物清单 */
export interface SceneManifest {
  scene_id: string;
  /** r2v 视频片段（参考图=选定场景图+角色立绘，直接出片，无关键帧中间层） */
  clip_url?: string;
  clip_duration_ms?: number;
  clip_failed?: boolean;
  /** 分角色配音 */
  narration_url?: string;
  narration_duration_ms?: number;
  /** r2v 生成 seed */
  seed: number;
}

export interface ProjectProgress {
  units_done: number;
  units_total: number;
}

export interface ScriptProjectRecord {
  id: string;
  /** 主题或整篇文章原文 */
  source: string;
  title?: string;
  style: StyleId;
  format: 'landscape' | 'portrait';
  lang: Lang;
  episode_count?: number;
  state: ProjectState;
  counters: ProjectCounters;
  error?: string;
  last_reject_reason?: string;
  progress: ProjectProgress;
  /** 剧本定稿后初始化；卡点环节逐角色更新 */
  characters: CharacterCard[];
  /** 剧本 locations 场景卡初始化；卡点环节逐地点更新（旧记录缺省，读盘时兜底） */
  locations: LocationCard[];
  /** 分镜阶段逐场更新 */
  scenes: SceneManifest[];
  export?: ExportArtifact;
  created_at: number;
  updated_at: number;
}

export class ProjectRepo {
  private cache = new Map<string, ScriptProjectRecord>();

  constructor(private readonly assets: AssetStore) {}

  create(record: ScriptProjectRecord): ScriptProjectRecord {
    this.cache.set(record.id, record);
    this.assets.writeProjectRecord(record);
    return record;
  }

  get(id: string): ScriptProjectRecord | undefined {
    const mem = this.cache.get(id);
    if (mem) return mem;
    const disk = this.assets.tryReadProjectRecord(id);
    if (disk) {
      const migrated = migrateLegacyState(disk);
      this.cache.set(id, migrated);
      return migrated;
    }
    return disk;
  }

  update(record: ScriptProjectRecord): void {
    this.cache.set(record.id, record);
    this.assets.writeProjectRecord(record);
  }
}

/**
 * 旧记录兼容：
 * - 旧自动批量阶段（scenes/clips_generating）→ 分镜工作台（改为逐场手动生成）
 * - 场景资产上线前的记录缺 locations / counters.locationRegens，读盘兜底（否则打开即崩）；
 *   旧 scenes[] 里的 keyframe_* 字段是死数据，无人读取，随下次写盘自然消失。
 */
function migrateLegacyState(record: ScriptProjectRecord): ScriptProjectRecord {
  const fixed: ScriptProjectRecord = {
    ...record,
    locations: record.locations ?? [],
    counters: { ...record.counters, locationRegens: record.counters.locationRegens ?? {} },
  };
  if (fixed.state === ('scenes_generating' as string) || fixed.state === ('clips_generating' as string)) {
    return { ...fixed, state: 'storyboard_review' };
  }
  return fixed;
}
