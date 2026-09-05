const STAGE_LABELS: Record<string, string> = {
  created: '准备中',
  story_generating: '故事编写中',
  story_moderating: '故事审核中',
  voice_review: '等待确认角色音色',
  pages_generating: '插画与配音生成中',
  enhance_generating: '视频片段生成中',
  ready: '生成完成',
  exporting: '视频导出中',
  completed: '已导出',
  // ---- 故事视频产线（projects）----
  script_analyzing: '剧本分析中',
  script_moderating: '剧本审核中',
  portraits_generating: '角色与场景图生成中',
  awaiting_character_confirmation: '等待确认角色与场景',
  storyboard_review: '分镜制作中（逐场手动）',
};

const FAILED_LABELS: Record<string, string> = {
  story_generating: '故事编写失败',
  story_moderating: '故事审核失败',
  voice_review: '音色确认失败',
  pages_generating: '插画与配音生成失败',
  enhance_generating: '视频片段生成失败',
  script_analyzing: '剧本分析失败',
  script_moderating: '剧本审核失败',
  portraits_generating: '角色立绘生成失败',
};

export function stateLabel(state: string): string {
  if (state.startsWith('failed_')) {
    const stage = state.slice('failed_'.length);
    return FAILED_LABELS[stage] ?? `${STAGE_LABELS[stage] ?? stage}失败`;
  }
  return STAGE_LABELS[state] ?? state;
}
