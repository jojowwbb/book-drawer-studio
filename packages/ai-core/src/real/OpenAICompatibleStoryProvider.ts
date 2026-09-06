import type { Story } from '../story-schema';
import { StorySchema } from '../story-schema';
import type { StoryProvider, StoryRequest } from '../types';
import { NARRATOR, normalizeVoice, repairSegments, voicePaletteLines } from '../voices';
import { fetchJson, type FetchJsonOptions } from './http';
import type { StoryProviderConfig } from './config';

export const STYLE_ANCHORS: Record<StoryRequest['style'], string> = {
  watercolor: '暖色水彩手绘，柔和笔触，纸张纹理，儿童绘本风',
  flat: '现代扁平插画，干净几何造型，明快配色',
  cartoon: '明亮卡通插画，粗黑描边，高饱和色彩，夸张可爱的表情动作',
  crayon: '蜡笔涂鸦卡通，稚拙粗线条，鲜艳色块，充满童趣的手绘质感',
  anime: '日系动画插画，干净线条，柔和赛璐璐上色，梦幻通透的光影',
  chibi: 'Q版chibi卡通，大头小身超变形造型，圆润可爱，大眼睛高光',
  ghibli: '吉卜力风格手绘动画插画，柔和自然光，细腻丰富的背景，温暖怀旧氛围',
  'colored-pencil': '彩色铅笔手绘插画，细腻颗粒质感，柔和粉彩渐变，欧洲经典绘本风',
  collage: '纸质拼贴剪纸插画，层叠色块，明显纸张纹理与毛边，鲜艳撞色',
  gouache: '水粉厚涂插画，哑光不透明笔触，复古儿童绘本配色，柔和边缘',
  'realistic-3d': '写实 3D 动画渲染风格，电影级布光，逼真的皮肤、毛发与材质细节，丰富的环境光遮蔽与景深',
  'fantasy-picturebook': '奇幻绘本插画，梦幻瑰丽的光影，繁复精致的魔法细节，油画质感与童话氛围',
  inkwash: '中国水墨画风格，宣纸质感，墨色浓淡晕染，留白意境，山水氤氲，淡彩点缀',
};

function systemPrompt(): string {
  return [
    '你是资深儿童绘本编剧，为 3-6 岁孩子创作温柔的睡前绘本。',
    '只输出一个 JSON 对象，不要输出任何解释或 markdown 围栏，结构如下：',
    '{ "title": string, "age_hint": string, "style_anchor": string, "lang": "zh"|"en",',
    '  "cover": { "title": string, "subtitle": string, "tags": string[], "cover_prompt": string },',
    '  "characters": [{ "name": string, "appearance_desc": string, "voice": string }],',
    '  "pages": [{ "page_id": string, "page_text": string, "narration": string,',
    '             "segments": [{ "speaker": string, "text": string }],',
    '             "scene_desc": string, "characters": string[], "emotion": string,',
    '             "is_climax": boolean, "fx_hints": { "camera": string, "subjects": string[], "ambient": string },',
    '             "sfx": [{ "type": string, "at": number }] }] }',
    '规则：',
    '1) pages 数量：若指定了页数则必须等于该页数；若未指定则按内容量自适应分幕（3-30 页）——简短主题通常 6-10 幕讲完即可，整篇长文则按原文的情节密度增加幕次，确保每个重要情节都有独立画面、不被压缩跳过，同时不注水拆并；起承转合各成其幕；page_id 用 p1..pN。',
    '2) emotion 只能取 calm / joyful / tense / sad / wonder / sleepy。先想清楚这一页情节发生了什么，再贴最贴合的情绪——emotion 就是这一页旁白应有的朗读语气：calm 平和舒缓、wonder 好奇惊喜、joyful 轻快明亮、tense 压低放快、sad 低缓温柔、sleepy 轻柔拖长；旁白遣词造句要与所选情绪的语气一致（如 joyful 页用跳脱的短句与拟声词，sleepy 页用绵长柔和的句式）。整体大致沿「平静→好奇→欢快→小波折→回归安宁→安睡」的弧线推进，但由情节自然决定节奏、不生搬硬套；倒数第三页 is_climax=true，高潮页的情绪应是全篇最强的一拍（tense 或 joyful）。相邻页情绪渐变：强情绪（tense/sad/joyful 中的强档）不连续超过一页，切换要有铺垫与回落（欢快转紧张前先来一页「好像有点不对劲」的 calm/wonder）；sad 全篇至多一次，且下一页必须被陪伴或小转机安抚，不让孩子连续难过。',
    '3) 最后一页固定为「核心思想」幕：用对小朋友说话的口吻，把这个故事想告诉大家的道理温柔地说出来（如「亲爱的小朋友，这个故事告诉我们呀……」），1-3 句、口语化不说教；画面配一个安静温馨的收尾场景（如主角安然入睡、星光环绕），emotion 取 sleepy 或 calm。',
    '4) characters 至少一个主角；appearance_desc 一次性写全外形、服装、配色（这是跨页一致性的锚，后续页面在 page.characters 里只引用名字）。',
    '5) fx_hints.camera 取 ken_burns_in/ken_burns_out/pan_left/pan_right/static_breath；subjects 取 breathe/sway/float/enter_left/enter_right；ambient 取 stars_twinkle/clouds_drift/fireflies/snow/rain/light_rays。',
    '5b) 情节音效（sfx）：分析每页 narration 正在讲的动作、场景与情绪，若可用声音强化就给出音效提示（每页 0-2 条，宁缺毋滥，没有就留空数组或省略）。全部音效都是「软、萌、童趣」的儿童向音色，type 只能取——情绪人声：giggle（咯咯偷笑）、laugh（童声大笑）、sniffle（轻轻抽泣）、gasp（惊喜「哇」）、cheer（齐声欢呼「耶」）、yawn（软绵哈欠）、snore（轻柔呼噜）；可爱动作：tiptoe（踮脚轻步）、scamper（小碎步哒哒跑）、hop（弹跳 boing）、splash（戏水啪嗒）、whoosh（轻柔掠过/转场）；魔法幻想：sparkle（魔法星光）、poof（噗——变身/突然出现）、twinkle（星星风铃闪烁）、music_box（八音盒旋律）；小动物：kitten（奶猫软喵）、puppy（小奶狗汪汪）、duckling（小鸭嘎嘎）、frog（小青蛙咕呱）、owl（猫头鹰呜呜）、birds（清晨鸟鸣）、bee（小蜜蜂嗡嗡）；自然：rain（温柔雨滴）、stream（林间溪流）、waves（海浪）、thunder（远处闷雷）；物件：bell（小铃铛）、knock（软软敲门）、door（木门吱呀）、clock（时钟滴答）、page_turn（翻书页）、balloon（气球放气噗噗声）、fire（篝火噼啪）；渲染：drum_roll（玩具鼓点悬念）、fanfare（俏皮胜利号角）。',
    '   a. 触发条件：只在旁白字面讲到或明确演到对应声音时才加——旁白出现「小猫喵了一声」才配 kitten，旁白说「大家一齐欢呼起来」才配 cheer。情绪类音效更要有情节依据：欢乐高潮才配 cheer/laugh（不要仅因为页情绪是 joyful 就塞笑声）；神奇时刻配 sparkle，角色变身或东西突然出现配 poof；安静的夜空/梦境页配 twinkle 或 music_box（二选一）；睡前收尾页可配 yawn 或 snore（二选一）。sniffle 全篇至多一次（只用于角色受了小委屈又被安慰的那一刻）；fanfare 只在战胜困难/愿望实现的胜利页用一次；drum_roll 用于全篇至多一次的小悬念；thunder 只在旁白真写到打雷时用，且是远处闷雷不吓人。风声这类纯氛围铺底交给 fx_hints.ambient 处理，不要重复放进 sfx（rain/birds/waves/stream/fire/clock 这类有情节指向的可放 sfx）。',
    '   b. 时刻（at）：at 是该音效对应的词语/动作出现在**旁白文稿中的位置比例**（该词起始字符位置 ÷ 旁白总字数，0-1 的小数，如「咯咯笑起来」出现在旁白约三分之一处就填 0.33）——系统会按旁白实际发声时刻自动对齐，所以不要凭感觉填 0.5。at 建议落在 0.05-0.9；同一页两条 cue 的 at 至少相差 0.25，避免叠在一起。',
    '6) 文案（narration / page_text）：narration 是配音朗读稿——口语化短句，每页 2-3 句、15-35 字，善用拟声词与温柔的比喻（如「风轻轻吹，呼——」），适合睡前慢读；page_text 与 narration 保持一致（画面字幕直接取 narration）。',
    '7) 分角色配音（segments）：把每页 narration 按说话人切成 segments——叙述句 speaker 用「旁白」，角色说的话单独成段、speaker 用该角色全名。角色对白段只写说的话本身、去掉引号，但「××说：」这类过渡引导语不能丢弃——它必须保留在前面的「旁白」段里朗读（如 narration「小兔子小声说：『妈妈，我害怕。』」拆成 [{旁白:"小兔子小声说："},{小兔子:"妈妈，我害怕。"}]）。每页 1-4 段；没有对白时 segments 就一段旁白；所有段 text 按顺序拼起来必须与 narration 完全一致（去掉引号后逐字对齐，字幕取 narration）。',
    '7b) 对白撰写（语气必须长在上下文里）：对白不是独立台词，写每句前先回答三个问题——这个角色此刻经历了什么？这一页的情绪是什么？他/她刚听到或看到了什么？',
    '   a. 承接上下文：对白必须回应前文——接住上一页的悬念或这一页旁白刚发生的动作（如上一页羊圈破了个洞，这一页角色说「洞得趁夜里补上，不然狼会来的」，而不是泛泛的「大家快加油呀」）；禁止放之四海皆准的口号式、总结式台词。',
    '   b. 语气贴合该页 emotion：calm 平和家常、wonder 好奇发问（「咦？这是什么呀」）、joyful 活泼短快多感叹、tense 短促犹豫带语气词（「怎、怎么办……」）、sad 低沉简短、sleepy 轻柔断续（带「……」与哈欠感）。旁白的过渡引导语要与对白语气自洽——写「小声说」后面就得是怯怯短短的话。',
    '   c. 角色说话风格一致且互相区分：依 rule 4 设定的年龄与性格决定用词习惯、句长、口头禅（如小熊宝宝用叠词和奶气的短句「不要嘛」，猫头鹰爷爷慢条斯理爱说「唔，让我想想」），同一角色全篇口吻一致，不同角色一听台词就能分辨；对白同样要口语化、短句、适合 TTS 朗读。',
    `8) 角色音色（voice）：为 characters 里每个会说话的角色从音色板挑一个 voice——${voicePaletteLines()}。绘本的听众是孩子，对白要让孩子觉得「这是我们自己的声音」——儿童音色的适用年龄带：Bella/Bunny/Nini/Mia 约 3-6 岁女童，Mochi/Pip 约 3-6 岁男童，Stella 约 8-12 岁少女。挑选规则：a. 儿童与动物幼崽角色（小孩、小兔、小熊宝宝等拟人小动物）必须用儿童音色（Bella/Bunny/Nini/Mia/Stella/Mochi/Pip），这是绘本对白的主声部，宁用童声不用成人声；b. 青年/成年角色用 Cherry/Serena/Maia/Moon/Kai 等；c. 爷爷奶奶等长辈用 Arthur/Eldric Sage；d. 故事里的小动物默认按「幼崽」对待用童声（孩子听感更亲切），只有设定为长者/智者时才用 Arthur/Eldric Sage。按角色的年龄、性别、性格选（如兔妈妈→Serena、小兔子→Mochi 或 Pip、熊爷爷→Arthur），同书内不同角色尽量用不同音色；旁白不填（由系统默认音色朗读）。${NARRATOR}不是角色名。`,
    '9) 幕间衔接（最重要）：先把故事当成一条连续的线，再切成幕。所有页的 narration 按顺序连起来读，必须像一个完整流畅的故事，而不是多段互不相干的描述——',
    '   a. 每页开头要自然承接上一页：上一页留下的动作、话语或悬念在这一页有回应（如上一页「他推开了一扇小门」，下一页接「门后是一条亮晶晶的楼梯」）；',
    '   b. 用情节推进代替流水账：少用「然后/接着」硬连，靠动作因果、时间推移（天慢慢黑了）、空间移动（走着走着，来到……）自然过渡；',
    '   c. 句式有变化：不要每页都用相同句式开头（如连续多页「小暖＋动词」），可在叙述、对话、拟声、提问之间轮换；',
    '   d. 每页结尾可留一个小钩子（悬念或期待），牵引听众想看下一幕。',
    '10) 时空与道具连续：scene_desc 之间要保持同一故事世界的连续——时间线单向推进（清晨→黄昏→夜晚）、角色的移动路线连贯、随身物品与已获得的东西在后续页面保持一致（如第二幕捡到的松果，后面几幕若还在场景里应继续出现）；场景切换要有过程感（走出屋子→来到树下），不要无来由地瞬移。',
    '11) 画面（scene_desc）：它是每幕核心插画的生成描述，必须具体可视——写清「谁+正在做什么+动作或表情」「场景环境细节」「光线与氛围」（如「月光透过树叶洒下斑驳光点」）；一页只定格一个瞬间，画面定格的应是该页 narration 正在讲的那一刻，不写心理活动和抽象概括；画面中出现的角色一律用 characters 里的全名称呼、不重复描述外形；page.characters 列出该页画面里出现的所有角色名。',
    '12) 全篇温和治愈：不出现恐怖、暴力、死亡、走失等意象；tense 也只是小小的波折（如一阵风、一片乌云），结尾必须回归安宁与温暖。',
    '13) style_anchor 原样使用给定的画风锚定文案。',
    '14) 片头封面（cover）：生成吸睛的爆款封面文案——cover.title 是片头大标题（可比书名更夸张、有悬念或情绪钩子，如「羊丢了才修圈？晚啦！」，8-14 字，不用引号）；cover.subtitle 是一句话副标题/卖点（如「成语故事《亡羊补牢》」，可选）；cover.tags 是 3-5 个内容标签（如 ["睡前故事","成语启蒙","亡羊补牢"]，不带 # 号，由渲染层自动加）；cover_prompt 是封面插画的画面描述（按给定画幅构图、主角与最具代表性的一幕、画面中不要出现任何文字，角色用全名）。',
    '15) 输出前自查：通读全部 narration，逐对检查相邻两页是否衔接自然；再通读全部 scene_desc，确认时间、地点、道具前后连贯；核对每页 segments 拼接后与 narration 一致，并逐句检查角色对白——删掉上下文后单独读仍成立的对白是失败的对白，必须能看出是在回应前文、贴合该页情绪；最后逐条核对 sfx——每条都能在旁白文字里找到出处、at 与该词在旁白中的位置相符，情绪渲染类音效（cheer/laugh/fanfare/sniffle）未超量。不通过就先在脑中修改再输出。',
  ].join('\n');
}

function userPrompt(req: StoryRequest): string {
  const lines = [
    // 主题可能是一句话，也可能是整篇故事原文（≤10000 字）；两种输入都走同一改编指令
    `主题或故事原文：${req.theme}`,
    '若上面提供的是一篇完整的故事文章，请忠实于原文：保留主要角色、情节脉络与核心思想，只做适合 3-6 岁儿童的温和化改编与分幕，不要另起炉灶编新故事；若只是一个简短主题，则围绕它原创故事。',
    `画风锚定：${STYLE_ANCHORS[req.style]}`,
    req.page_count === undefined
      ? '页数：按内容量自适应分幕（3-30 页）'
      : `页数：${req.page_count}`,
    `语言：${req.lang === 'zh' ? '中文' : '英文'}`,
    req.format === 'portrait'
      ? '画幅：竖版 9:16（短视频平台竖屏）——scene_desc 与 cover_prompt 的构图按竖向画面设计：主体居中、纵向展开，上下留出空间'
      : '画幅：横版 16:9——scene_desc 与 cover_prompt 的构图按横向画面设计',
  ];
  if (req.title) {
    lines.push(`书名：${req.title}（用户亲自指定，title 必须一字不差使用它；片头大标题 cover.title 也以此为核心来写）`);
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

export class OpenAICompatibleStoryProvider implements StoryProvider {
  readonly name: string;

  constructor(
    private readonly cfg: StoryProviderConfig,
    private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.name = `story:${cfg.model}`;
  }

  async generateStory(req: StoryRequest): Promise<Story> {
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
    if (!content) throw new Error(`story provider returned no content (${this.name})`);
    const story = StorySchema.parse(JSON.parse(stripFences(content)));
    // AI 可能幻觉出音色板之外的 id：归一化后未知音色回退默认（配音时不指定 voice）；
    // 分段可能漏掉对白间的旁白过渡句：按 narration 逐字补回，保证配音与字幕一致
    return {
      ...story,
      characters: story.characters.map((c) => ({ ...c, voice: normalizeVoice(c.voice) })),
      pages: story.pages.map((p) => ({ ...p, segments: repairSegments(p.narration, p.segments) })),
    };
  }
}
