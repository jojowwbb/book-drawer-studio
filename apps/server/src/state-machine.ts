export const GENERATION_STAGES = [
  'story_generating',
  'story_moderating',
  'voice_review',
  'pages_generating',
  'enhance_generating',
] as const;

export type GenerationStage = (typeof GENERATION_STAGES)[number];

export type BookState =
  | 'created'
  | GenerationStage
  | 'ready'
  | 'exporting'
  | 'completed'
  | `failed_${GenerationStage}`;

export type BookEvent =
  | { type: 'START' }
  | { type: 'STAGE_DONE' }
  | { type: 'STAGE_FAILED'; error: string }
  | { type: 'TEXT_REJECTED'; reason: string }
  | { type: 'RESUME' }
  | { type: 'START_EXPORT' }
  | { type: 'EXPORT_DONE' }
  | { type: 'EXPORT_FAILED'; error: string };

export interface BookCounters {
  stageRetries: number;
  moderationRounds: number;
  pageRegens: Record<string, number>;
}

export const MAX_STAGE_RETRIES = 3;
export const MAX_MODERATION_ROUNDS = 2;
export const MAX_PAGE_REGENS = 3;

export function initialCounters(): BookCounters {
  return { stageRetries: 0, moderationRounds: 0, pageRegens: {} };
}

export function isGenerationStage(s: string): s is GenerationStage {
  return (GENERATION_STAGES as readonly string[]).includes(s);
}

export type TransitionResult =
  | { ok: true; state: BookState; counters: BookCounters }
  | { ok: false; error: string };

const NEXT_STAGE: Record<GenerationStage, GenerationStage | 'ready'> = {
  story_generating: 'story_moderating',
  story_moderating: 'voice_review',
  voice_review: 'pages_generating',
  pages_generating: 'enhance_generating',
  enhance_generating: 'ready',
};

function okResult(state: BookState, counters: BookCounters): TransitionResult {
  return { ok: true, state, counters };
}

function failResult(error: string): TransitionResult {
  return { ok: false, error };
}

export function transition(
  state: BookState,
  event: BookEvent,
  counters: BookCounters,
  opts: { enhance?: boolean } = {},
): TransitionResult {
  switch (event.type) {
    case 'START':
      if (state === 'created') {
        return okResult('story_generating', { ...counters, stageRetries: 0 });
      }
      return failResult(`cannot START from ${state}`);

    case 'STAGE_DONE': {
      if (!isGenerationStage(state)) return failResult(`cannot STAGE_DONE from ${state}`);
      // 视频改版后 enhance_generating（逐页片段）是必经阶段
      return okResult(NEXT_STAGE[state], { ...counters, stageRetries: 0 });
    }

    case 'STAGE_FAILED': {
      if (!isGenerationStage(state)) return failResult(`cannot STAGE_FAILED from ${state}`);
      const retries = counters.stageRetries + 1;
      const nextCounters = { ...counters, stageRetries: retries };
      if (retries > MAX_STAGE_RETRIES) {
        return okResult(`failed_${state}`, nextCounters);
      }
      return okResult(state, nextCounters);
    }

    case 'TEXT_REJECTED': {
      if (state !== 'story_moderating') return failResult(`cannot TEXT_REJECTED from ${state}`);
      const rounds = counters.moderationRounds + 1;
      const nextCounters = { ...counters, moderationRounds: rounds };
      if (rounds > MAX_MODERATION_ROUNDS) {
        return okResult('failed_story_moderating', nextCounters);
      }
      return okResult('story_generating', { ...nextCounters, stageRetries: 0 });
    }

    case 'RESUME': {
      if (!state.startsWith('failed_')) return failResult(`cannot RESUME from ${state}`);
      const stage = state.slice('failed_'.length) as GenerationStage;
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
