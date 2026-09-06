import type { ScriptAnalysis } from '../script-schema';
import { normalizeScriptLocations, normalizeScriptSpeakers, ScriptAnalysisSchema } from '../script-schema';
import type { ScriptProvider, ScriptRequest } from '../types';
import { NARRATOR, normalizeVoice, voicePaletteLines } from '../voices';
import { fetchJson, type FetchJsonOptions } from './http';
import type { StoryProviderConfig } from './config';
import { STYLE_ANCHORS } from './OpenAICompatibleStoryProvider';

function systemPrompt(): string {
  return [
    '你是资深影视编剧与分镜师，把用户投喂的主题或整篇文章改编成可拍摄的故事视频剧本。',
    '面向通用观众（不限低幼），保留原文的情节张力与情感浓度，只做视听化改编。',
    '只输出一个 JSON 对象，不要输出任何解释或 markdown 围栏，结构如下：',
    '{ "title": string, "logline": string, "style_anchor": string, "lang": "zh"|"en",',
    '  "characters": [{ "id": string, "name": string, "appearance": string, "costume": string,',
    '                  "personality": string, "voice": string }],',
    '  "locations": [{ "id": string, "name": string, "description": string }],',
    '  "episodes": [{ "id": string, "title": string,',
    '                "scenes": [{ "id": string, "title": string, "synopsis": string,',
    '                             "dialogues": [{ "speaker": string, "line": string }],',
    '                             "location_id": string, "scene_prompt": string, "camera": string,',
    '                             "narration": string, "sfx": [{ "type": string, "at": number }] }] }] }',
    '规则：',
    '1) 忠实改编：若投喂的是完整文章，保留主要角色、情节脉络与核心主旨，按原文情节密度分集分场，重要情节不被压缩跳过；若只是简短主题，则围绕它原创剧本。',
    '2) 分集分场：集数 1-3 集（若指定集数则必须等于该集数），每集按情节起伏划分；总场次 3-24 场，起承转合各成其场；episode id 用 e1..eN，scene id 用 s1..sN 全局连续编号。',
    '3) characters 1-8 个：id 用 c1..cN；appearance 一次性写全五官、发型、体型、配色（这是立绘与跨场一致性的锚，后续只引用名字）；costume 写服装；personality 一句话性格。角色形象优先中国面孔（东亚五官特征、黑发褐瞳等），服装与造型优先中式元素，除非主题原文明确指定其他文化背景。',
    `4) 角色音色（voice）：为每个有台词的角色从音色板挑一个——${voicePaletteLines()}。按年龄、性别、性格选，不同角色尽量用不同音色；${NARRATOR}不是角色名、不填音色。`,
    '5) 每场 dialogues ≤6 条（防输出超限）：只放角色之间的对白——speaker 必须逐字等于 characters 里某个角色的 name 全名（不能写简称、不能写 id、不能加书名号或空格、绝不能写「旁白」），台词归属严格按原文：谁说的话就填谁的 name，绝不张冠李戴；拿不准是谁说的就不写进 dialogues；叙述性内容一律写进 narration（本场旁白朗读稿，可选，1-2 句），绝不同时写进 dialogues 与 narration 造成重复；line 只写说的话本身、不带引号、单条 ≤30 字。',
    '6) locations 场景资产卡 1-12 个：id 用 l1..lN；先把全剧出现过的地点逐一登记（同一地点只登记一份），description 写该地点的空间结构、固定陈设、材质与色调（这是环境跨场一致性的锚，后续场次只引用 id）；不要写角色、天气或瞬时光线——那些属于单场画面。',
    '7) 每场必须填 location_id 引用一个已登记的场景卡：一场只发生在一个地点，换地点就拆成新一场；scene_prompt 的环境部分只写该地点内本场的动态与光线（如「夕阳把码头的缆绳染成金色」），不得改写或虚构场景卡里没有的固定陈设——防止场景幻觉。',
    '8) scene_prompt 是画面描述（关键帧插画与视频共用），必须按「主体动作＋环境光影」两部分组织：先写「谁+正在做什么+动作或表情」（具体到身体部位与朝向，角色用全名、不重复描述外形），句号后用「环境光影：」引出本场在该地点内的动态元素与光线方向色温。一场只定格一个瞬间，定格的应是本场高潮时刻。',
    '9) camera 是本场的镜头运动描述（图生视频用，≤30 字）：写清起幅到落幅，如「从特写缓慢拉远并微微上仰」「跟随主体横移」「固定机位轻微呼吸感」；情绪紧张用推近，交代环境用拉远，对话对峙用固定或缓慢横移。',
    '10) 幕间连续：所有场的 synopsis 按顺序连起来读必须是一条完整流畅的故事线——时间单向推进、空间移动有过程、道具前后一致；场与场之间用动作因果或悬念自然衔接，少用「然后/接着」硬连。',
    '11) 情节音效（sfx，可选，全部为儿童向柔和音色）：type 只能取——giggle/laugh/sniffle/gasp/cheer/yawn/snore；tiptoe/scamper/hop/splash/whoosh；sparkle/poof/twinkle/music_box；kitten/puppy/duckling/frog/owl/birds/bee；rain/stream/waves/thunder；bell/knock/door/clock/page_turn/balloon/fire；drum_roll/fanfare。at 是出现时刻占本场时长的比例（0-1 小数）。只在台词或旁白真的讲到对应声音时才加，每场 0-2 条。',
    '12) style_anchor 原样使用给定的画风锚定文案；logline 是一句话故事梗概（≤40 字）。',
    '13) scene_prompt 与 camera 的质量直接决定成片观感，参考范例（假设已登记场景卡 l1「悬崖边：嶙峋的黑色岩石平台，边缘插着褪色的旗杆，云海在崖下终年翻涌」）——',
    '    输入图像：一位穿着精致盔甲的卡通小猫将军站在悬崖边。',
    '    location_id：「l1」',
    '    scene_prompt：「主体动作：小猫将军转过头看向镜头，眼神坚定，举起手中的佩剑挥舞一下。环境光影：背景中悬崖边的云海在缓慢翻滚，金色夕阳洒在盔甲上反射出耀眼的光芒。」',
    '    camera：「镜头从特写缓慢拉远并微微上仰」',
    '14) 输出前自查：通读全部 synopsis 确认故事线连贯；核对每场 location_id 都指向已登记的场景卡、scene_prompt 未虚构场景卡外的固定陈设；核对 scene_prompt 里的角色都用全名、且含「主体动作」与「环境光影」两部分；确认每场 dialogues ≤6 条且无「旁白」条目。',
  ].join('\n');
}

function userPrompt(req: ScriptRequest): string {
  const lines = [
    `主题或文章原文：${req.source}`,
    '若上面提供的是一篇完整文章，请忠实改编；若只是简短主题，则围绕它原创剧本。',
    `画风锚定：${STYLE_ANCHORS[req.style]}`,
    req.episode_count === undefined
      ? '集数：按内容量自定（1-3 集）'
      : `集数：${req.episode_count}`,
    `语言：${req.lang === 'zh' ? '中文' : '英文'}`,
    req.format === 'portrait'
      ? '画幅：竖版 9:16（短视频平台竖屏）——scene_prompt 的构图按竖向画面设计：主体居中、纵向展开'
      : '画幅：横版 16:9——scene_prompt 的构图按横向画面设计',
  ];
  if (req.title) {
    lines.push(`作品名：${req.title}（用户亲自指定，title 必须一字不差使用它）`);
  }
  if (req.reject_reason) {
    lines.push(`上一版因「${req.reject_reason}」被驳回，请规避该问题并输出修正后的新版本。`);
  }
  return lines.join('\n');
}

function stripFences(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return fenced ? fenced[1]! : text.trim();
}

export class OpenAICompatibleScriptProvider implements ScriptProvider {
  readonly name: string;

  constructor(
    private readonly cfg: StoryProviderConfig,
    private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.name = `script:${cfg.model}`;
  }

  async analyzeScript(req: ScriptRequest): Promise<ScriptAnalysis> {
    const opts: FetchJsonOptions = {
      fetchImpl: this.opts.fetchImpl,
      timeoutMs: this.opts.timeoutMs ?? 120_000,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    };
    const out = await fetchJson<{ choices: { message: { content: string } }[] }>(
      `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        model: this.cfg.model,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(req) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.8,
      },
      opts,
    );
    const content = out.choices[0]?.message.content;
    if (!content) throw new Error(`script provider returned no content (${this.name})`);
    const analysis = ScriptAnalysisSchema.parse(JSON.parse(stripFences(content)));
    // AI 可能幻觉出音色板之外的 id：归一化后未知音色回退默认（配音时不指定 voice）；
    // 场景引用同样归一化：幻觉 location_id 置空回退无锚定；
    // 台词说话人归一化：简称/id/空格/幻觉旁白一律解析回角色名或并入旁白，杜绝错配
    return normalizeScriptLocations(
      normalizeScriptSpeakers({
        ...analysis,
        characters: analysis.characters.map((c) => ({ ...c, voice: normalizeVoice(c.voice) })),
      }),
    );
  }
}
