/**
 * 故事视频产线状态机：主题文章 → 剧本分析 → 角色定制（人工卡点）→ 分镜绘制 → 视频合成。
 * 与绘本 state-machine 平行独立：多一个 awaiting_character_confirmation 暂停态，
 * 生成阶段 STAGE_DONE 在此处停靠，直到用户 CONFIRM_CHARACTERS 放行。
 */

export const PROJECT_GENERATION_STAGES = [
  'script_analyzing',
  'script_moderating',
  'portraits_generating',
] as const;

export type ProjectGenerationStage = (typeof PROJECT_GENERATION_STAGES)[number];

export type ProjectState =
  | 'created'
  | ProjectGenerationStage
  /** 卡点：角色立绘与场景图已出，等待用户挑选并确认全部资产 */
  | 'awaiting_character_confirmation'
  /** 分镜工作台：逐场手动 r2v 生成视频，全部出片后进 ready */
  | 'storyboard_review'
  | 'ready'
  | 'exporting'
  | 'completed'
  | `failed_${ProjectGenerationStage}`;

export type ProjectEvent =
  | { type: 'START' }
  | { type: 'STAGE_DONE' }
  | { type: 'STAGE_FAILED'; error: string }
  | { type: 'TEXT_REJECTED'; reason: string }
  /** 卡点放行：全员角色已选定 */
  | { type: 'CONFIRM_CHARACTERS' }
  /** 分镜工作台：全部场次片段就绪，允许导出 */
  | { type: 'STORYBOARD_DONE' }
  /** 重画导致片段不再齐备：ready 退回工作台 */
  | { type: 'STORYBOARD_REOPEN' }
  | { type: 'RESUME' }
  | { type: 'START_EXPORT' }
  | { type: 'EXPORT_DONE' }
  | { type: 'EXPORT_FAILED'; error: string };

export interface ProjectCounters {
  stageRetries: number;
  moderationRounds: number;
  /** 单角色立绘重生成次数（改描述重出） */
  portraitRegens: Record<string, number>;
  /** 单场景图重出次数（改描述重出） */
  locationRegens: Record<string, number>;
  /** 单场关键帧/片段重画次数 */
  sceneRegens: Record<string, number>;
}

export const MAX_STAGE_RETRIES = 3;
export const MAX_MODERATION_ROUNDS = 2;
export const MAX_PORTRAIT_REGENS = 3;
export const MAX_LOCATION_REGENS = 3;

export function initialProjectCounters(): ProjectCounters {
  return { stageRetries: 0, moderationRounds: 0, portraitRegens: {}, locationRegens: {}, sceneRegens: {} };
}

export function isProjectGenerationStage(s: string): s is ProjectGenerationStage {
  return (PROJECT_GENERATION_STAGES as readonly string[]).includes(s);
}

export type ProjectTransitionResult =
  | { ok: true; state: ProjectState; counters: ProjectCounters }
  | { ok: false; error: string };

const NEXT_STAGE: Record<ProjectGenerationStage, ProjectState> = {
  script_analyzing: 'script_moderating',
  script_moderating: 'portraits_generating',
  // 立绘完成后不直接进分镜，而是停在卡点等待人工确认
  portraits_generating: 'awaiting_character_confirmation',
};

function okResult(state: ProjectState, counters: ProjectCounters): ProjectTransitionResult {
  return { ok: true, state, counters };
}

function failResult(error: string): ProjectTransitionResult {
  return { ok: false, error };
}

export function transitionProject(
  state: ProjectState,
  event: ProjectEvent,
  counters: ProjectCounters,
): ProjectTransitionResult {
  switch (event.type) {
    case 'START':
      if (state === 'created') return okResult('script_analyzing', { ...counters, stageRetries: 0 });
      return failResult(`cannot START from ${state}`);

    case 'STAGE_DONE': {
      if (!isProjectGenerationStage(state)) return failResult(`cannot STAGE_DONE from ${state}`);
      return okResult(NEXT_STAGE[state], { ...counters, stageRetries: 0 });
    }

    case 'STAGE_FAILED': {
      if (!isProjectGenerationStage(state)) return failResult(`cannot STAGE_FAILED from ${state}`);
      const retries = counters.stageRetries + 1;
      const nextCounters = { ...counters, stageRetries: retries };
      if (retries > MAX_STAGE_RETRIES) return okResult(`failed_${state}`, nextCounters);
      return okResult(state, nextCounters);
    }

    case 'TEXT_REJECTED': {
      if (state !== 'script_moderating') return failResult(`cannot TEXT_REJECTED from ${state}`);
      const rounds = counters.moderationRounds + 1;
      const nextCounters = { ...counters, moderationRounds: rounds };
      if (rounds > MAX_MODERATION_ROUNDS) return okResult('failed_script_moderating', nextCounters);
      return okResult('script_analyzing', { ...nextCounters, stageRetries: 0 });
    }

    case 'CONFIRM_CHARACTERS': {
      if (state !== 'awaiting_character_confirmation') {
        return failResult(`cannot CONFIRM_CHARACTERS from ${state}`);
      }
      return okResult('storyboard_review', { ...counters, stageRetries: 0 });
    }

    case 'STORYBOARD_DONE': {
      if (state !== 'storyboard_review') return failResult(`cannot STORYBOARD_DONE from ${state}`);
      return okResult('ready', counters);
    }

    case 'STORYBOARD_REOPEN': {
      if (state !== 'ready') return failResult(`cannot STORYBOARD_REOPEN from ${state}`);
      return okResult('storyboard_review', counters);
    }

    case 'RESUME': {
      if (!state.startsWith('failed_')) return failResult(`cannot RESUME from ${state}`);
      const stage = state.slice('failed_'.length) as ProjectGenerationStage;
      return okResult(stage, { ...counters, stageRetries: 0 });
    }

    case 'START_EXPORT':
      if (state === 'ready') return okResult('exporting', counters);
      return failResult(`cannot START_EXPORT from ${state}`);

    case 'EXPORT_DONE':
      if (state === 'exporting') return okResult('completed', counters);
      return failResult(`cannot EXPORT_DONE from ${state}`);

    case 'EXPORT_FAILED':
      if (state === 'exporting') return okResult('ready', counters);
      return failResult(`cannot EXPORT_FAILED from ${state}`);
  }
}
