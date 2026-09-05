# project.md — AI 协作者项目简报

> 本文档是给 AI 助手（Claude/Codex 等）的项目上下文简报，目标是让新的 AI 不重新摸索即可参与开发。
> 最后更新：2026-09-04。随架构变化必须同步更新本文档。

## 1. 项目是什么

**绘本工坊（picturebook-studio）**：C 端产品。**两条独立产线**（web 首页互切）：

- **绘本工坊**（`/`、`/api/books`）：家长输入一句话主题 → AI 生成一本「会动的绘本」故事视频（MP4）。
- **故事视频工坊**（`/project/create`、`/api/projects`）：主题文章 → 剧本分析 → **角色与场景定制（人工卡点：立绘+场景图三选一）** → **分镜工作台（逐场手动 r2v 参考图生视频，确认无误再继续）** → 全 AI 片段合成成片。面向通用内容（不限低幼），默认画风 anime。详见 §4/§5 的 projects 部分与 `script-pipeline.ts`。

当前管线（2026-08 五次大改版后）：

```
DeepSeek 生成故事 JSON → 百炼通义万相逐页文生图 → 插画经 PixiJS headless 逐帧渲染成每页 5s 片段 + 旁白台词经百炼 qwen3-tts 自动逐页合成 narration.wav
→ ffmpeg 幕间交叉溶解（xfade+acrossfade，默认 600ms，`PB_EXPORT_TRANSITION_MS=0` 回到 concat 硬切）拼接成 H.264 MP4（含旁白的页先混音再拼接，旁白合成失败的页无声）→ 最后混入内置背景音乐（帕赫贝尔《D 大调卡农》钢琴版，由 `export/bgm.ts` 加法合成离线渲染成 WAV 缓存到 `assets/bgm/canon-piano.wav`，约 12% 音量铺在旁白之下、首尾淡入淡出，视频流拷贝不重编码；`PB_BGM=off` 关闭，可指向自定义音频路径）
```

- **演示模拟模式已移除**：生产启动无条件构建真实供应商（缺 key 即 `MissingEnvError` fail-fast）；`PB_PROVIDERS=fake` 与 Fake 全套仅作 Playwright e2e / 单测的确定性桩，不是产品功能。
- **片段来源只有 canvas**：`HeadlessClipRenderer` 逐帧渲染插画产 `clip.mp4`，画面与插画 100% 一致、零 AI 成本。绘本线不提供逐页 AI 图生视频（曾为可选增强，已移除；AI 生视频统一归故事视频产线逐场 r2v 参考图使用）。
- **旁白配音随视频阶段自动逐页合成**（不再是手动增强）：`generateClips` 阶段每页片段渲染完成后调用 `Pipeline.ensureNarration`，**分角色配音**：该页 `segments`（AI 按说话人拆分的旁白/对白段）逐段合成——旁白段不指定 voice（走 `TTS_VOICE` 默认音色），角色段用 `story.characters[].voice`（AI 从 `ai-core/voices.ts` 音色板挑选，`normalizeVoice` 校验防幻觉 id，同一角色跨页查同一名字→音色天然一致），段间 250ms 静音由 `ai-core/wav.ts` 的 `concatWavs` 拼接成 `narration.wav`（ffprobe 探测时长入清单）；合成前经 `ai-core/voices.ts` 的 `repairSegments` 兜底——AI 分段常把两句对白间的旁白过渡句（如「阿牛却摆摆手说：」）整个删掉导致配音漏读，该函数按去引号后的 narration 逐字定位各段、把遗漏文字补回为独立旁白段（定位失败的段保守保留）；角色音色段失败回退旁白音色重试一次；单页合成发 SSE `page_narration: generating/ready/failed` 事件、失败只跳过该页语音、不阻塞成片；重画插画时旁白文本未变则保留。无 `segments` 的旧书视为单段旁白，行为不变。`POST /api/books/:id/redub`（预览页「重新配音」按钮）可让旧书按修复后的分段逐页重合成旁白（不重渲染插画/片段，回到 ready 并清空旧成片供重新导出）。导出时含旁白的页先 ffmpeg 混音（旁白延迟 800ms 起播、anullsrc 静音轨补齐片段时长、AAC 44.1k 立体声；旁白含前后各 800ms 呼吸超过片段时长时该页 `tpad` 冻结尾帧延长），无旁白的页保持流拷贝。
- **音效层（两路，`PB_SFX=off` 全关）**：
  - **情节音效（文案生成阶段分析）**：`StoryPage.sfx`（`[{type, at}]`，33 种 type——动作/情绪声 laugh/giggle/cry/applause/cheer/gasp/sigh/magic/whoosh/heartbeat/yawn/snore，动物叫 cat/dog/rooster/duck/frog/cow，自然/物件 footsteps/door/knock/bell/thunder/birds/water/waves/fire/clock/phone/balloon/page_turn，渲染 drum_roll/fanfare；at=页时长比例）——故事 prompt 规则 5b 让 AI 逐页分析 narration 的动作、动物与情绪（高潮配 applause/cheer、神奇时刻配 magic、紧张配 heartbeat、睡前配 yawn/snore、旁白出现动物叫配对应 species），`buildSceneSpec` 透传进 `SceneSpec.sfx`（渲染层忽略）；导出时 `export/sfx.ts` 的 `ensureSfxWav` 优先取**内置录音库** `apps/server/assets/sfx/<type>.wav`（Pixabay 免版权音效，已裁剪 0.5-6s、峰值归一 -3dB、单声道 22.05kHz，共 4.2MB），内置缺失回退算法拟音（合成 WAV 缓存 `assets/sfx/`），`concat-exporter` 按 `at×页时长` 用 adelay 定位混入旁白轨（`mixNarration`/`addSilence` 均支持）。
  - **环境声（视觉氛围派生）**：`pickSfx` 按每页 `SceneSpec.ambient` 选 lavfi 噪声轨——rain→粉噪+低通（雨声）、snow/clouds_drift→布朗噪声+低通+慢颤音（风声），约 5-6% 音量整页铺底；星点/流萤/光束安静不配音效。
- **文案编辑（预览页）**：`PUT /api/books/:id/pages/:pageId/text`（正文页 `{narration}`、片头幕 `{cover}`，先过文本审核）→ `Pipeline.editPageText`：更新 story 文本（手改后 segments 重置为单旁白段）→ 只重配该页语音 + 重渲染该页片段（插画不动），发 `page_clip ready` 供前端重载预览，旧成片作废回 ready。前端 `PreviewPane` 提供「编辑旁白 / 编辑片头文案」表单。
- **竖屏画幅（9:16 短视频平台）**：`BookRecord.format`（`landscape` 默认 | `portrait`，创建时入参、web 首页可选）。`Pipeline.bookPageSize` 按书取渲染尺寸（portrait 固定 1080×1920，旧书缺省横版），贯穿故事 prompt（`StoryRequest.format` 注入画幅提示）、插画 prompt（`orientationHint` 竖/横构图词）、BookSpec 尺寸与 SceneView 自适应布局（背景 cover 缩放、字号双轴钳制）；web 预览容器经 `--pb-ar` CSS 变量按 spec 宽高比伸缩。
- **已废弃**（历史设计，勿恢复）：**全自动**图生视频产全片（画面与插画脱节）、**绘本线逐页 AI 图生视频增强**（`clip-ai.mp4` / `clip_source` 切换，已彻底移除）、主体抠图分层、逐页**手动**触发 TTS 配音（现为视频阶段自动合成）、BGM 混音、主备厂商切换、smoke 脚本、双语出片。当前为**单语（zh）**。
- 内容审核三关（输入/文本/图像）调用点保留但实现为 Fake（对外发布前必须接真实审核）。

## 2. 技术栈与硬性环境

| 项 | 要求 | 原因/备注 |
|---|---|---|
| Node.js | ≥ 22 | 用了原生 `process.loadEnvFile`、全局 fetch |
| pnpm | ≥ 9 | workspace：`packages/*` + `apps/*` |
| TypeScript | 5.9 strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` | 数组索引需 `?.`/`!`；**类型导入必须 `import type`** |
| ffmpeg/ffprobe | ≥ 7.1 | 片段编码与拼接（PATH 中可用即可） |
| Playwright Chromium | 1.49 | headless 渲染 + e2e |
| vitest | 2.x | 注意：vitest 2 内建 vite 5 类型，**与 vite 6 的插件类型冲突**——web 的 vitest 配置不得加载 @vitejs/plugin-react |

运行入口统一用 `tsx`（原生 node --experimental-strip-types 解析不了无扩展名导入）。从仓库根 `node --import tsx/esm apps/server/src/index.ts` 会因 tsx 不在根 node_modules 而失败——**在 apps/server 目录内执行**。

## 3. Monorepo 结构

```
packages/
  renderer/  @pb/renderer  PixiJS v8 渲染引擎（纯前端包，也会被 headless 使用）
             - src/schema.ts      BookSpec/SceneSpec zod schema + CAMERA_TYPES(5)/SUBJECT_FX_TYPES(5)/AMBIENT_TYPES(6)
             - src/rng.ts         mulberry32/FNV hashSeed（确定性渲染的种子域）
             - src/frame/         SceneSampler（固定步长采样）+ FrameState
             - src/view/          SceneView（7 层场景渲染，load() 拉取资产）
             - src/player/        BookPlayer（canvas + BookSpec；init/play/pause/seek/renderAt/pageIndexAt/destroy）
             - src/export/        renderFrames（离线逐帧生成器，栅栏式 ceil(d/dt)+1 帧）
             - harness/           vite 小页面（端口 5199），暴露 window.__pb 供 Playwright 驱动
  ai-core/   @pb/ai-core    纯逻辑包（无 DOM 依赖）
             - story-schema.ts    Story JSON zod schema（见 §5）
             - script-schema.ts   ScriptAnalysis zod schema（故事视频产线：分集分场 + 角色卡，见 §5）
             - types.ts           ProviderBundle：{ story, image, matting, tts?, moderation }（绘本产线无视频 provider）
                                  （tts 供管线视频阶段自动合成旁白）
                                  ProjectProviders：{ script, image, videoClip, tts, moderation }（故事视频产线专用）
             - fake/              Fake 全套（故事模板/剧本模板/渐变图/假抠图/假审核/假TTS/假图生视频，仅测试桩）
             - real/              DeepSeek 故事 + DeepSeek 剧本分析（OpenAICompatibleScriptProvider） + 百炼文生图（可切 OpenAI 兼容文生图） + 百炼图生视频 + 百炼 Qwen-TTS 适配器 + IdentityMattingProvider
             - env-file.ts        loadRepoEnvFile（向上找 pnpm-workspace.yaml，加载仓根 .env）
apps/
  server/    @pb/server    Fastify 5：REST+SSE、状态机管线、串行队列、
             export/clip-source.ts（ClipSource：HeadlessClipRenderer——canvas 片段来源）、
             pipeline.ts（generateClips 内 ensureNarration 逐页自动合成旁白）、
             export/concat-exporter.ts（ffmpeg concat + 旁白混音 mixNarration）、export/harness-driver.ts（vite+chromium 管理）
             —— 公共层（两条产线共用）：export/clip-join.ts（joinClips：xfade 拼接 + 旁白/BGM/音效混音核）、util/run-pool.ts（runPool 并发池）、events.ts（泛型 EventHub<M>）
             —— 故事视频产线：project-state-machine.ts（含 awaiting_character_confirmation 卡点态与 storyboard_review 工作台态）、
             project-repo.ts（ScriptProjectRecord，加载时旧批量态自动迁移 storyboard_review）、script-assembly.ts（剧本 prompt 组装 + 时长估算 + 角色一致性锚定）、
             script-pipeline.ts（ScriptPipeline：前半自动 + 分镜逐场手动生成）、projects-api.ts（独立 SerialQueue + 单场 keyframe/clip 端点）、
             export/project-exporter.ts（复用 joinClips，全 AI 片段拼接）
  web/       @pb/web       React 18 + Vite 6 + react-router 7：创作表单、SSE 进度、PixiJS 预览、
             逐页旁白回放试听、导出下载
             故事视频产线：ProjectCreatePage（/project/create）、ProjectPage（/project/:id，角色墙 + 分镜卡片墙）、
             useProjectStream（SSE）、api/project-client.ts + project-types.ts
```

## 4. 状态机与 REST API

状态（`apps/server/src/state-machine.ts`，纯函数迁移表）：

```
created → story_generating → story_moderating → pages_generating
        → enhance_generating → ready → exporting → completed
失败：failed_{stage}（阶段重试 ≤3 次耗尽后进入）；POST /resume 回到该阶段（产物不重跑）
导出失败：EXPORT_FAILED → ready（幂等，可重试）
```

**`enhance_generating` 是必经阶段**（语义=逐页 headless 渲染视频片段），不存在跳过路径。片段渲染并发化：`HarnessDriver` 维护 browser page 池（`PB_HARNESS_PAGES`，默认 3），`generateClips` 用 `CLIP_CONCURRENCY` 工作池借还 page 并行渲染；旁白 TTS（纯网络 I/O，`NARRATION_CONCURRENCY`）与片段渲染两条链同时进行；进度按正文页乱序完成单调递增。

REST（开发模式下前端经 Vite 代理 `/api` 与 `/assets`）：

| 方法/路径 | 说明 |
|---|---|
| POST `/api/books` | body `{theme, title?, style?, lang?, format?, page_count?, enhance?}` → 201 `{book_id}`；400=审核驳回 `input_rejected`；`title` 用户主动输入的书名（可选，≤50 字，与 theme 一并送审；定稿后服务端强制覆盖 `story.title` 与片头大标题 `cover.title`，留空则由 AI 生成）；`lang` `zh|en`（默认 zh，整本书文案/字幕/旁白语音按此语言生成，内部 `langs=[lang]`）；`format` `landscape|portrait`（默认横版 16:9；portrait 竖版 9:16=1080×1920，插画按竖构图生成）；`page_count` 缺省时由 AI 按内容量自适应分幕（3-30，schema 兜底；长文增加幕次铺展情节） |
| GET `/api/books/:id` | 状态/进度/错误；ready 后含 `preview.book_specs` + `clips`（逐页旁白 url 与 image_failed 标记）；导出后含 `exports.zh` |
| GET `/api/books/:id/events` | SSE：`state`/`progress`/`completed`/`failed`/`page_clip`/`page_narration`（JSON data 行） |
| POST `/api/books/:id/pages/:pageId/regenerate` | 单页重画（图 + canvas clip 重建、旁白保留），≤3 次，仅 ready |
| PUT `/api/books/:id/pages/:pageId/text` | 文案编辑：正文页 `{narration}`（≤200 字）、片头幕（pageId=title）`{cover:{title,subtitle?,tags?}}`；先过文本审核，202 异步只重配该页语音+重渲该页片段（插画不动），完成后发 `page_clip ready`、旧成片作废 |
| POST `/api/books/:id/export` | 仅 ready；含旁白的页先混音再拼接 → completed |
| POST `/api/books/:id/resume` | `failed_*` → 该阶段 |
| GET `/assets/*` | 静态产物 |

前端 useBookStream：**SSE 常开不关闭**（导出/旁白事件也靠它），completed 或 `page_clip ready` 事件触发重新 GET 完整状态；`page_clip` ready 递增 `clipVersions`（文案编辑后据此重载预览），`page_narration` 的 generating/failed 存 `narrationStates`、ready 递增 `narrationVersions`（回放 cache-buster）供预览页逐页展示。

### 故事视频产线状态机（`project-state-machine.ts`，与绘本平行独立）

```
created → script_analyzing → script_moderating → portraits_generating
        → ⏸ awaiting_character_confirmation（人工卡点，CONFIRM_CHARACTERS 才放行）
        → storyboard_review（分镜工作台：逐场手动 r2v 生成视频）
        → ready（全部场次片段齐备，STORYBOARD_DONE 自动进入）→ exporting → completed
失败：failed_{stage}（阶段重试 ≤3 次耗尽）；POST /resume 回到该阶段（产物不重跑）
文本审核驳回：script_moderating --TEXT_REJECTED--> script_analyzing（≤2 轮回环）
导出失败：EXPORT_FAILED → ready（幂等）
重画导致片段不齐：ready/completed --STORYBOARD_REOPEN--> storyboard_review（旧成片丢弃）
```

卡点语义：`NEXT_STAGE[portraits_generating] = awaiting_character_confirmation`；`portraits_generating` 阶段**同时**为每角色出 3 版立绘与每地点出 3 版场景图（同一 `generateImageVariants` 核，资产间并发 ≤3，进度 =（角色数+地点数）×3）。管线 `run()` 到达卡点即停，前端「角色墙 + 场景墙」各自做「三选一 / 改描述重出（每卡 ≤3 轮，新描述先过文本审核）」；confirm 要求**全部角色 + 被任一场 `location_id` 引用的地点**已选定（未引用地点不阻塞）。confirm 会把选定立绘的 appearance/costume/voice 与定稿场景 description 写回 `script.json`，并初始化全部场次 `SceneManifest`（无任何产物），随后进入 `storyboard_review` 分镜工作台。

**分镜工作台为逐场手动生成**（降低真实 API 测试成本）：已取消关键帧静帧中间层，每场一步「生成视频」——`generateSceneClip` 用 **r2v 参考图直出**（media = 该场选定场景图 + 出场角色选定立绘）+ 自动补配音；单场操作幂等（已有 `clip_url` 直接 advance 返回）。全部场次出片后 `advanceStoryboardIfNeeded` 自动发 `STORYBOARD_DONE` 进 ready；ready/completed 后重画某场则 `STORYBOARD_REOPEN` 退回工作台并丢弃旧成片。`regenerateScene`（重画这一场：换 seed 重跑该场 r2v、保留配音）**无次数限制**——逐场手动点击本身即成本控制。旧项目的 `scenes_generating`/`clips_generating` 状态在 `project-repo.ts` 加载时自动迁移为 `storyboard_review`；旧记录缺 `locations`/`locationRegens` 读盘兜底，旧 `keyframe_*` 字段是死数据。

r2v prompt 组装（`buildR2vRequest`，单函数同产 prompt+referenceImages 保证「图N」编号与 media 顺序一致）：图1=选定场景图、图2..N=出场角色立绘；prompt 五段式——①主体动作：「图N是{名称}」绑定 + 原样 `scene_prompt` + 口型约束 ②镜头运动（`camera` 缺省缓推、首尾同构图）③速度节奏 ④美学风格（`style_anchor` + 「角色与场景外形严格与参考图一致」）。**参考图 ≤5 上限**：`selectR2vCast` 截断——有场景图时角色 ≤4，超限优先保留有对白的说话人，被挤掉角色只在 prompt 里文字描述外形（`castOut`）；无场景图时角色上限放宽到 5，并在 prompt 里用「环境设定：{name}——{description}」文字锚定回退。参考图一张都没有（旧项目无场景资产且该场无出场角色）直接抛错拒绝出片。

口型与音画对齐：r2v 同样无唇形同步能力，`buildR2vRequest` **不把旁白原文喂给视频模型**（旁白是画外音，只走 TTS 导出混音），并按场音频构成下发口型指令——纯旁白场要求所有人物嘴唇全程闭合、只用表情肢体运镜传达；含对白场只允许说话人轻微开合、其余角色闭口。剧本 system prompt 规则 5、8-9/14 强制 `scene_prompt` 按「主体动作：…环境光影：…」两段填写并附小猫将军 few-shot 范例；`dialogues` 禁止出现「旁白」条目（叙述内容一律走 `narration`，防止重复朗读与口型错乱）。

场景资产防幻觉：剧本分析先登记 `locations` 场景卡（1-12 个，同一地点只登记一份，description 锁定空间结构/固定陈设/材质色调），每场用 `location_id` 引用且**一场只发生在一个地点**（换地点拆新场）；`scene_prompt` 环境部分不得虚构场景卡外的陈设。场景图 prompt（`buildLocationPrompt`）为「{name}的空镜头全景，画面中不出现任何人物、动物与角色」+ description 逐字锚定，尺寸随项目画幅（landscape 用全局 pageSize、portrait 1080×1920）；同一地点跨场共用**同一张选定场景图**做 r2v 参考图，环境从根上一致。AI 幻觉出的未知 `location_id` 由 `normalizeScriptLocations` 在 parse 后置空（回退无锚定），场景 id 重复去重保留首个。

工作台脚本展示：`GET /api/projects/:id` 视图附带 `script`（`assets.tryReadScript`，分析完成前缺省）；前端按 scene_id 建索引，每个场次卡片内嵌可折叠「分镜脚本」区块（标题/剧情/旁白/对白/画面/场景/运镜/时长），未出片的场默认展开便于核对。

REST（`projects-api.ts`，独立 SerialQueue）：

| 方法/路径 | 说明 |
|---|---|
| POST `/api/projects` | body `{source, title?, style?=anime, format?=landscape, lang?=zh, episode_count?}` → 201 `{project_id}`；source+title 先过文本审核；`style` 视频风格预设 `realistic-3d\|anime\|fantasy-picturebook\|inkwash`（真人3D/卡通二次元/奇幻绘本/水墨国风，与绘本画风独立） |
| GET `/api/projects/:id` | 状态/进度 + `characters[]`（versions 各版立绘 + selected）+ `locations[]`（场景卡：versions 各版场景图 + selected）+ `scenes[]`（SceneManifest：clip/narration url 与 failed 标记）+ `export` + `script` + `capabilities.ai_video` |
| GET `/api/projects/:id/events` | SSE：`state`/`progress`/`completed`/`failed`/`portrait`/`location`/`scene_clip`/`scene_narration`（逐单元 generating/ready/failed，projectId 维度） |
| PUT `.../characters/:charId/select` | `{seed}` 选定某版立绘（仅卡点态，seed 必须已有落盘版本） |
| POST `.../characters/:charId/regenerate` | 改描述重出 3 版（202 异步，SSE `portrait ready` 后前端重拉全量），≤3 轮 |
| PUT `.../locations/:locId/select` | `{seed}` 选定某版场景图（仅卡点态） |
| POST `.../locations/:locId/regenerate` | 改场景描述重出 3 版（202 异步，SSE `location ready` 后重拉），≤3 轮，新描述先过文本审核 |
| POST `.../characters/confirm` | 全部角色 + 被引用场景已选定才放行（否则 409，错误信息区分 characters/locations），202 → `storyboard_review`（只初始化场次清单，不自动生成任何产物） |
| POST `.../scenes/:sceneId/clip` | 逐场手动出视频片段（r2v 参考图直出 + 自动补配音；202 异步，SSE `scene_clip` 事件通知）；幂等（已有 clip 直接完成）；出片后若全部齐备自动进 ready；无任何参考图（旧项目兜底失败）该场标 `clip_failed` |
| POST `.../scenes/:sceneId/regenerate` | 单场重画（换 seed 重跑该场 r2v，配音保留），**无次数限制**，旧成片作废退回工作台 |
| POST `/api/projects/:id/export` / `resume` | 语义同绘本 |

分镜阶段并发：改为逐场手动触发后不再有批量并发池——每次点击只入队一个单元任务（独立 SerialQueue 串行执行），配音逐段 TTS（角色音色失败回退旁白重试一次）。单场失败只标 `clip_failed` 供用户单独重画，不影响其它场次。

## 5. 数据契约（改任何一处都会连锁）

- **Story JSON**（ai-core `StorySchema`，LLM 输出的信任边界——必须 `StorySchema.parse`）：`{title, age_hint, style_anchor, lang:'zh'|'en', cover?:{title,subtitle?,tags[],cover_prompt}, characters[{name,appearance_desc}], pages[3..14]:{page_id, page_text, narration, scene_desc, characters[], emotion(六枚举), is_climax, fx_hints{camera,subjects[],ambient}}}`。
- **片头幕（title scene）**：`story.cover` 存在时，server 以伪页 `page_id='title'`（不进 `story.pages`，不影响页数/末页核心思想逻辑）生成爆款封面插画（`buildCoverImagePrompt`，16:9、画面无文字），并在 `buildBookSpec` 时前置为第一幕；标题/副标题/标签由渲染层 `title_overlay` 叠加（SceneView.buildTitleOverlay，含渐变压暗底衬），时长 `TITLE_DURATION_MS = 3600`、无字幕。片头旁白用默认旁白音色只念大标题（`coverNarrationText`，副标题与标签不念），随视频阶段合成并计入该页清单，导出时同样混入并支持超时延长；重画封面保留旁白，重新配音覆盖片头。封面插画与正文页并行生成（不计入页数进度），重画走 `regeneratePage(id, 'title')`。
- **fx_hints 是字符串**（非渲染枚举）：由 server 的 scene-assembly 对照 `@pb/renderer` 枚举校验，非法值回退到 emotion 兜底规则（主通道+兜底通道设计）。
- **SceneSpec/BookSpec**（renderer schema，预览与成片的唯一输入）：正文页 `duration_ms` **固定 5000**（=片段时长契约）；`background.src`/`subjects[].src` 指向 `/assets/...` 相对 URL；`audio_refs` 字段保留但不再赋值。
- **PageAssets**（server 落盘 `pages/{pageId}/assets.json`）：`{page_id, seed, image_url, background_url, subject_urls[], foreground_url?, clip_url?, clip_duration_ms?, narration_url?, narration_duration_ms?, image_failed?, image_error?}`。片段只有 canvas 一种来源（`clip.mp4`）；旁白导出时混入该片段。
- **时长事实源**：成片时长 = Σ `clip_duration_ms`（canvas 片段 = 实际帧数/fps）。**禁止用 duration_ms 推帧边界**（renderFrames 是栅栏式 `ceil(d/dt)+1` 帧，末帧 clamp）。
- 单页默认 5s：`scene-assembly.ts` 的 `PAGE_DURATION_MS = 5000`。
- **Script JSON**（故事视频产线，ai-core `ScriptAnalysisSchema`，同为 LLM 信任边界必须 parse）：`{title, logline?, style_anchor, lang, characters[1..8]:{id,name,appearance,costume?,personality,voice?}, locations[0..12]:{id,name,description}, episodes[1..3]:{id,title,scenes[≥1]:{id,title?,synopsis,dialogues[≤6]:{speaker,line},location_id?,scene_prompt,camera?(≤30字运镜),duration_hint?(2-30s),narration?,sfx?}}}`，refine 总场次 3-24。落盘 `projects/{id}/script.json`；角色卡/场景卡定制态（versions/selected）在 `project.json` 的 `characters[]`/`locations[]`，confirm 时单向写回 script.json。
- **SceneManifest**（`project.json` 的 `scenes[]`）：`{scene_id, seed, clip_url?, clip_duration_ms?, clip_failed?, narration_url?, narration_duration_ms?}`（r2v 直出，无关键帧中间层；旧记录残留 `keyframe_*` 字段是死数据）。seed = `hashSeed(projectId:sceneId) + sceneRegens[sceneId]`，重画换 seed。
- **LocationCard**（`project.json` 的 `locations[]`，与 CharacterCard 对称）：`{id, name, description, versions:[{seed,url?,failed?,error?}], selected?}`；场景图落盘 `projects/{id}/locations/{locId}/v{N}.png`。`ProjectCounters.locationRegens[locId]` 记重出轮次（≤3）。

## 6. Provider 层（ai-core/real）

`createRealProviders(config)`（config 来自 env，经 `loadRealProvidersConfig`）：

| 能力 | 适配器 | 关键 API 事实 |
|---|---|---|
| story | `OpenAICompatibleStoryProvider`（DeepSeek） | POST `{base}/chat/completions`，`response_format: json_object`；输出剥 markdown 围栏后 `StorySchema.parse`；支持 `reject_reason` 驳回回环；`page_count` 指定则严格等页、缺省则 prompt 要求「按内容量自适应分幕（3-30 页）」；system 提示词内含完整 JSON 形状与角色一致性策略（首出场完整描述+后续引用名字） |
| script | `OpenAICompatibleScriptProvider`（DeepSeek，故事视频产线） | 同 chat/completions + json_object；输出 `ScriptAnalysisSchema.parse`；prompt 要求分集分场、角色设定卡（appearance 是可锚定的视觉描述）、逐场 `scene_prompt`；支持 `reject_reason` 驳回回环 |
| image | `DashScopeImageProvider` | **同步** `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`（qwen-image-2.0 系列只支持同步；**不得带 X-DashScope-Async 头**）；body `input.messages[{role:'user',content:[{text}]}]` + `parameters{size,n,watermark,seed}`；图片 URL 在 `output.choices[0].message.content[0].image`（24h 有效立即下载）；size 用推荐档位：16:9→`2688*1536`（2.0 系列） |
| image | `OpenAICompatibleImageProvider` | 可选文生图链路（`IMAGE_API=openai` 时装配）：`POST {IMAGE_BASE_URL}/images/generations`，body `{model,prompt,n,size[,response_format,seed]}`；size 按宽高比映射 1024/1536 档位；响应取 `data[0].url`（下载）或 `data[0].b64_json`（解码）；`gpt-image*`/`dall-e*` 原生模型自动省略 seed/response_format |
| videoClip | `DashScopeVideoProvider`（默认）/ `OpenAICompatibleVideoProvider`（`VIDEO_API=newapi`）/ `OpenAIVideosProvider`（`VIDEO_API=openai`），由 `providers.ts` 的 `createVideoProvider` 按 `config.video.api` 路由 | **异步**生视频，dashscope 走 `POST {base}/services/aigc/video-generation/video-synthesis`（必带 `X-DashScope-Async: enable`），按 `req.referenceImages` 判别两分支：**r2v 参考图生视频**（默认链路，wan2.7-r2v）`input.media=[{type:'reference_image',url}]`（1–5 张 PNG data URL，顺序=prompt「图N」编号）+ `parameters{resolution,ratio,duration,prompt_extend:false,watermark,seed}`——`prompt_extend` 必须显式 false，否则模型改写 prompt 破坏图N 指代；**i2v 首尾帧**（防御保留）`media=[{type:'first_frame'},{type:'last_frame'}]`。轮询 `GET {base}/tasks/{task_id}` 至 SUCCEEDED，`output.video_url`（24h 有效）立即下载。newapi/openai 只支持 i2v 形态，收到 referenceImages 显式抛 unsupported。r2v **仅故事视频产线使用**（storyboard_review 工作台逐场手动点击调用）；绘本产线已移除逐页 AI 图生视频 |
| tts | `DashScopeTtsProvider` | **同步** `POST {base}/services/aigc/multimodal-generation/generation`（qwen3-tts-flash），body `input{text,voice,language_type}`；音频 URL 在 `output.audio.url`（24h 有效立即下载）。由管线视频阶段逐页自动合成，产出 narration.wav，导出时混音；单页失败不阻塞成片 |
| matting | `IdentityMattingProvider` | 整图单层（subjects=[]），真实模式零配置；仅影响预览分层动效 |
| moderation | `FakeModerationProvider` | 真实审核厂商未定；发布前必须替换 |

env（仓根 `.env`，自动加载；shell 变量优先）：**四类能力统一四元组格式**——前缀 `TEXT` / `IMAGE` / `VIDEO` / `TTS`，每组 `<前缀>_API`（协议选择）/ `<前缀>_BASE_URL` / `<前缀>_API_KEY`（必填，缺任一启动即抛 `MissingEnvError`，fail-fast 故意设计）/ `<前缀>_MODEL`。默认值：TEXT=openai @api.deepseek.com/deepseek-chat；IMAGE=dashscope @百炼/qwen-image-2.0；VIDEO=dashscope @百炼/wan2.7-r2v-2026-06-12；TTS=dashscope @百炼/qwen3-tts-instruct-flash（另有 `TTS_VOICE` 默认 Cherry、`TTS_INSTRUCTIONS`）。`PB_PROVIDERS=fake` 仅供 e2e。

注意：`qwen-mt-image-*`（图片翻译）与 `wan3.0-*` **不存在**，别再配。

## 7. 关键不变量与踩坑记录（AI 最容易踩雷的部分）

1. **PixiJS canvas 复用死锁**：`BookPlayer.destroy()` 会让 canvas 的 WebGL 上下文丢失（GlContextSystem 必然调 WEBGL_lose_context）；**在同一 canvas 上重新 `Application.init` 会死锁主线程**（rAF 停摆、页面无响应，macOS headless 复现）。规则：
   - 每个 BookPlayer 实例必须配全新 canvas；harness 导出会话一会话一 canvas；
   - React 侧换 spec 前**先把 spec 置 null 卸载旧播放器**（`PreviewPane.reload` 开头的 `setSpec(null)` 就是为此）；
   - BookPlayerCanvas 清理函数在 init 未 settle 时延后 destroy（避免向已销毁上下文上传纹理）。
2. **确定性渲染四选项**：Application 初始化必须 `resolution: 1, antialias: false, preference: 'webgl'` + 种子入 spec——预览/成片逐帧一致依赖这些；黄金帧基线测试守护。
3. **DashScope 报文细节**：size 星号分隔（`2688*1536`）；图片/视频 URL 24h 有效立即下载；`fetchJson` 是 POST 专用、GET 下载用 `fetchRaw`；错误响应体 `{code, message}` 顶层；图生视频必须带 `X-DashScope-Async: enable`（文生图**不得**带）。
4. **测试零真实网络**：真实供应商行为用 fixture + 注入 `fetchImpl` 锁定；管线单测注入 stub `ClipSource`（写 3 字节假 clip）与 stub `videoClip` provider；`buildApp` 测试必须显式注入 `providers: createFakeProviders()`（否则触发真实供应商的 env fail-fast）；headless 真实路径只由专门集成测试（需 chromium+ffmpeg）与 web e2e 覆盖。
5. **e2e 隔离端口**：Playwright 用 8788（server）/5174（web），`reuseExistingServer: false`；vite 端口经 `WEB_PORT` env、API 源经 `PB_API_ORIGIN`；**开发者手动服务在 8787/5173，两者可共存**——e2e 失败先怀疑复用了手动服务。
6. **harness 端口 5199**：vite 只绑 localhost（IPv6），**用 `http://localhost:5199` 而非 127.0.0.1**；harness 无法解析 `/assets` 相对 URL，渲染前必须 `absolutizeSceneUrls` 成 API 源绝对地址（server 开 CORS）。
7. **.env 加载**：`loadRepoEnvFile` 向上找 workspace 根；`process.loadEnvFile` 不覆盖已有 shell 变量；e2e 用 playwright `webServer.env` 传 `PB_PROVIDERS=fake` 确保隔离。
8. **DATA_DIR 相对 server 进程 cwd**（= apps/server），e2e 设 `DATA_DIR=data-e2e`、`PB_ASSET_ORIGIN=http://127.0.0.1:8788`。
9. **ffmpeg 7.1.1**：`amix duration=first` 在复合滤镜图里会被截断（历史坑，混音已删但写新滤镜时注意）；concat 用 `-f concat -safe 0 -c copy`。
10. **tsx 运行位置**：包内脚本从包目录跑；顶层 await 的脚本用 `.mts` 扩展名（根 package.json 无 `"type":"module"`）。

## 8. 命令

```bash
pnpm install
pnpm test          # 四包 371 个测试（renderer 44 / ai-core 99 / web 52 / server 176）
pnpm typecheck
pnpm --filter @pb/server start          # 后端 :8787（自动读仓根 .env，缺 key 启动即失败）
pnpm --filter @pb/server dev            # watch 模式
pnpm --filter @pb/web dev               # 前端 :5173
pnpm --filter @pb/web test:e2e          # 全链路 e2e（8788/5174，含导出）
pnpm --filter @pb/renderer test:e2e     # 渲染包 harness e2e
```

e2e 全链路冒烟（Fake 桩，仅供测试，非产品功能）：

```bash
PORT=8790 DATA_DIR=/tmp/pb-e2e PB_PROVIDERS=fake pnpm --filter @pb/server start
curl -X POST http://127.0.0.1:8790/api/books -H 'content-type: application/json' -d '{"theme":"小熊第一次看海","page_count":3}'
# 轮询 GET /api/books/{id} 至 ready → POST .../export → exports/zh.mp4（3 页约 15s 成片，生成约 2 分钟）
```

## 9. 文档地图

- `README.md` — 使用文档（快速开始/API 参考/排障）
- `docs/superpowers/specs/` — 设计文档：`2026-08-29-ai-picturebook-video-platform-design.md`（原始 MVP 设计，管线部分已被取代）、`2026-08-29-picturebook-video-gen-pivot-design.md`（**当前架构**，顶部修订记录含三次调整）
- `docs/superpowers/plans/` — 6 份实现计划（TDD 步骤级，含执行期修正记录）
- `.trae/documents/story-video-pipeline-plan.md` — 故事视频产线（projects）实现计划（Step 0-9）
- 里程碑 tag：`renderer-v0.1.0` → `pipeline-v0.1.0` → `web-v0.1.0` → `export-v0.1.0` → `real-providers-v0.1.0` → `video-gen-v0.1.0`

## 10. 开发工作流约定

- 流程：brainstorming（关键决策问人）→ spec（docs/superpowers/specs）→ writing-plans（docs/superpowers/plans，步骤含完整代码与 checkbox）→ TDD 逐任务执行（红→绿→提交）→ 全量回归 → 打 tag。
- 提交信息：conventional commits + scope（如 `feat(server): …`）；计划文档的 checkbox 执行完用 `sed -i '' 's/^- \[ \]/- [x]/'` 勾选并单独提交。
- UI 文案全部中文；不改 `@pb/renderer` 除非明确需要（导出/渲染契约变更走设计文档）。
- **计划文档中的代码若执行时发现 bug，修复代码的同时必须同步修正计划文档**（保持计划与实现一致是本仓库的既有实践）。

## 11. 当前状态与已知缺口

- 六个计划 + 视频转型 + 「移除演示模式 / 逐页 AI 图生视频」+ 「旁白配音（TTS + 导出混音）」+ 「旁白并入视频阶段自动合成（去分步）」+ 「故事视频产线（projects：剧本→角色卡点→分镜 i2v→全 AI 成片）」+ 「分镜改为逐场手动生成（storyboard_review 工作台，降低真实 API 测试成本）」+ 「i2v → r2v 参考图生视频 + 场景图资产（取消关键帧中间层，角色立绘与场景图直接喂 r2v 锁一致性）」全部完成，测试全绿。
- 缺口（按优先级）：
  1. 百炼真实 API 首跑校准：图像/视频/TTS 适配器按官方文档 fixture 实现，实际字段漂移（size 档位、`wan2.7-r2v` 的 reference_image media/ratio 参数、任务轮询返回结构、`qwen3-tts-flash` 的 `output.audio.url` 结构）会在第一次真实调用暴露，修 `packages/ai-core/src/real/` 下对应适配器即可；
  2. 生产部署形态（目前 dev server 形态；需静态托管前端 + 服务端常驻 + HTTPS）；
  3. 真实内容审核（现 Fake）；
  4. 双语（已移除但数据契约 `Lang`、ProviderBundle 扩展位保留，可按计划 5 架构加回）；旁白 TTS 已随视频阶段自动逐页合成，多语言旁白随双语出片一并恢复；
  5. `enhance` 开关语义退化（状态恒经 enhance_generating；字段保留仅为 API 兼容）；
  6. AI 片段与 canvas 片段编码参数可能不一致（分辨率/像素格式/时基），若 ffmpeg concat 流拷贝报错，需统一编码参数或改重编码拼接；含旁白混音的页会重编码音频轨（视频流仍拷贝），混音页与非混音页拼接时注意音频参数对齐（统一 AAC 44.1k 立体声）。
