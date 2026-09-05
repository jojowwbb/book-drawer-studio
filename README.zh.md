# 绘本工坊（Picturebook Studio）

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-green)
![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A5%209-orange)

[English](README.md) · **中文**

输入一句话主题，自动生成一本「会动的绘本」故事视频：LLM 写故事 → 文生图模型画插画 → PixiJS 逐帧渲染每页动画 → TTS 分角色配音 → ffmpeg 混音拼接成带旁白的 H.264 MP4。浏览器实时预览、单页重画、音色配置、一键导出下载。

产品包含**两条独立产线**（web 首页可互切）：

1. **绘本工坊**（`/`）：面向低幼绘本，canvas 逐帧渲染插画动画为唯一片段来源，画面与插画 100% 一致。
2. **故事视频工坊**（`/project/create`）：面向通用故事视频——主题文章 → AI 剧本分析（分集分场 + 角色设定卡 + 场景卡）→ **人工卡点：每角色三选一立绘、每地点三选一场景图，可改描述重出** → **分镜工作台（人工逐场点「生成视频」，r2v 参考图直出，逐个确认）** → 全 AI 片段合成成片。

没有演示模拟模式：产品始终调用真实 AI 供应商（缺 key 启动即失败）。

## 特性

- **分角色配音**：故事携带 `segments: [{speaker, text}]`，叙述段用旁白音色、对白段用为该角色挑选的音色，跨音色自动响度归一
- **音色确认卡点**：剧本定稿后产线自动暂停，先试听、改配旁白与角色音色，再开始花插画与配音的成本
- **插画即画面**：每个片段由浏览器预览同一套 PixiJS 代码 headless 逐帧渲染产出（「预览即导出」）
- **音效设计**：AI 在文案阶段分析每页旁白，在精确时刻挂接情节音效（33 种），并按场景氛围铺环境声（雨/雪/风）
- **背景音乐**：默认在旁白之下铺一首内置钢琴卡农；创建时可逐书关闭
- **稳健导出**：幕间统一交叉溶解、逐输入归一化（混合分辨率片段可干净拼接）、旁白超时自动冻结尾帧延长该页
- **横竖画幅**：每本书可选 16:9 或 9:16
- **可恢复产线**：状态机持久化，失败阶段重试不重跑已完成产物
- **零网络测试**：377 个单元/集成测试全部离线运行（Fake 供应商 + fixture 锁真实行为）；Playwright e2e 以确定性桩跑通完整产品

## 工作原理

```
一句话主题 / 整篇文章
        │
        ▼
  story_generating ──► story_moderating ──► ⏸ voice_review ──► pages_generating ──► ready ──► exporting ──► completed
   LLM 产出 Story     内容安全审核          （人工）            逐页文生图 +          预览、     片段交叉溶解      旁白 + 音效 + BGM
   JSON（页、对白      + 重试（≤3 次）       试听并改配          PixiJS 片段 +        导出       拼接、混音
   段、音效、                                旁白/角色音色       逐页旁白 TTS
   封面、角色）
```

- 页数由 AI 按内容量自适应决定（3–30 页）；最后一页固定为温和的「中心思想」收尾幕。
- 片头封面幕与正文并发生成并排在片首；片头旁白用确认后的旁白音色朗读书名。
- 文生图失败依次走换 seed 重试与「软化 prompt」兜底；仍失败则落占位图并跳过（可在预览页单独重画），单页失败绝不阻塞整本书。
- 某页旁白 TTS 失败只跳过该页语音，不阻塞成片。

## 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 22 | 运行时（原生 `process.loadEnvFile`、`fetch`） |
| pnpm | ≥ 9 | workspace 包管理 |
| ffmpeg / ffprobe | ≥ 7 | 片段封装与成片导出 |
| Playwright Chromium | 1.49 | headless 片段渲染与 e2e（首次运行 `pnpm --filter @pb/web exec playwright install chromium`） |

还需要四组 AI 能力的 API key（可分别指向不同厂商，也可全部指向同一个网关）：

| 能力 | 前缀 | 协议 | 默认端点 / 模型 |
|---|---|---|---|
| 文本（故事 + 剧本分析） | `TEXT` | `openai`（OpenAI 兼容 `/chat/completions`） | DeepSeek / `deepseek-chat` |
| 文生图 | `IMAGE` | `dashscope`（百炼原生）/ `openai`（`/images/generations`） | 阿里百炼 / `qwen-image-2.0` |
| AI 生视频（仅故事视频产线） | `VIDEO` | `dashscope`（r2v 参考图生视频）/ `newapi` / `openai`（Sora） | 百炼 / `wan2.7-r2v` |
| 旁白配音 | `TTS` | `dashscope`（Qwen-TTS；另有 `TTS_VOICE` / `TTS_INSTRUCTIONS`） | 百炼 / `qwen3-tts-instruct-flash` |

四个 `*_API_KEY` 全部必填（启动 fail-fast）；接同一家网关时四个 key 填同一个值即可。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入四组 API_KEY
```

```bash
# 终端 1 —— 后端 API（默认端口 8787，产物落在 apps/server/data/）
pnpm --filter @pb/server start

# 终端 2 —— 前端（默认端口 5173）
pnpm --filter @pb/web dev
```

打开 **http://localhost:5173**：

1. 输入一句话主题（如「孩子怕黑」），可选填书名、画风、语言、画幅、背景音乐开关，点「开始创作」
2. 进度页经 SSE 实时显示状态
3. 剧本定稿后产线**停在音色确认页**：逐个试听旁白与角色音色（内置预生成试听素材），不满意可改配，然后确认
4. 插画与配音开始生成；预览页可自动播放、缩略图翻页、单页重画、编辑某页文案（只重配该页语音并重渲染该页片段）
5. 点「导出视频」，成片在页面内播放并可下载

## 配置项参考（环境变量 / .env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PB_PROVIDERS` | — | `fake` 仅供 Playwright e2e 注入确定性桩；生产始终真实供应商 |
| `PORT` | `8787` | 后端监听端口 |
| `DATA_DIR` | `data` | 产物数据目录（相对后端进程 cwd） |
| `PB_PAGE_SIZE` | `1920x1080` | 横版成片分辨率（调小可加速链路验证） |
| `PB_EXPORT_FPS` | `30` | 片段帧率 |
| `PB_EXPORT_TRANSITION_MS` | `600` | 幕间交叉溶解时长（ms），`0` 关闭回到硬切 |
| `PB_BGM` | 内置卡农钢琴版 | 全局 BGM 文件路径；`off` 关闭（创建页的逐书开关优先于此） |
| `PB_SFX` | 开启 | 音效层（情节音效 + 环境声）；`off` 全部关闭 |
| `PB_VOICE_REVIEW` | 开启 | 剧本定稿后停在 `voice_review` 等人工确认音色；`off` 自动放行（批量/自动化产线） |
| `PB_DEFAULT_PAGE_COUNT` | — | 强制页数（3–30，主要供 e2e 注入）；缺省由 AI 按内容量自适应分幕 |
| `PB_ASSET_ORIGIN` | `http://127.0.0.1:<PORT>` | headless 渲染拉取资产的 API 源 |
| `PB_HARNESS_PAGES` | `3` | 片段渲染的 browser page 池大小（每 page 一个 WebGL context，低配机器可调小） |
| `TEXT_*` / `IMAGE_*` / `VIDEO_*` / `TTS_*` | 见「快速开始」 | 四组独立供应商配置：`_API` / `_BASE_URL` / `_API_KEY` / `_MODEL` |

## API 参考

所有接口同源于后端（开发模式下 Vite 代理 `/api` 与 `/assets`）。

### 绘本产线

| 方法/路径 | 说明 |
|---|---|
| POST `/api/books` | 创建绘本并启动管线。Body：`theme` 必填（1–10000 字）、`title?`、`style?`、`lang?`（`zh\|en`）、`format?`（`landscape\|portrait`）、`page_count?`（3–30）、`enhance?`、`bgm?`（默认 true）。`201 {book_id}` |
| GET `/api/books/:id` | 状态 + 进度；就绪后含 `preview.book_specs`、`exports`、`clips`；停在 `voice_review` 时含 `voice_review.characters` / `narrator_voice` |
| GET `/api/books/:id/events` | SSE：`state` / `progress` / `completed` / `failed` / `page_clip` / `page_narration` |
| GET `/api/books/:id/characters` | 音色确认卡点：角色列表 + 旁白音色 + 音色板（仅 `voice_review` 状态） |
| PUT `/api/books/:id/characters` | 改配音色：`{voices: {"<角色名>": "<音色>" \| null, "旁白": "<音色>"}}`（key `旁白` 改旁白；`null` 回退供应商默认） |
| POST `/api/books/:id/confirm-voices` | 确认音色，推进到插画与配音阶段。`202` |
| POST `/api/books/:id/pages/:pageId/regenerate` | 单页重画（`ready` 可用，每页 ≤3 次；`title` 重生成片头封面）。`202 {remaining}` |
| PUT `/api/books/:id/pages/:pageId/text` | 文案编辑：正文页 `{narration}`，片头幕 `{cover:{title,subtitle?,tags?}}`；只重配该页语音 + 重渲染该页片段。`202` |
| POST `/api/books/:id/export` | 拼接各页片段成成片（仅 `ready`）。`202 {state:"exporting"}` |
| POST `/api/books/:id/resume` | 从 `failed_*` 恢复（已完成产物不重跑）。`202` |
| GET `/assets/*` | 静态产物：插画分层、每页片段、BookSpec JSON、成片 MP4 |

状态机：

```
created → story_generating → story_moderating → voice_review → pages_generating
        → enhance_generating → ready → exporting → completed
失败：failed_{stage}（阶段重试 ≤3 次后进入；POST /resume 回到该阶段）
导出失败：回到 ready（幂等，可重新导出）
```

### 故事视频产线

| 方法/路径 | 说明 |
|---|---|
| POST `/api/projects` | `{source（1–10000 字）, title?, style?, format?, lang?, episode_count?（1–3）}` → `201 {project_id}` |
| GET `/api/projects/:id` | 状态 + 角色（各版立绘）+ 地点（各版场景图）+ 场次清单 + 剧本 + 导出产物 |
| GET `/api/projects/:id/events` | SSE：`state` / `progress` / `portrait` / `location` / `scene_clip` / `scene_narration` |
| PUT `/api/projects/:id/characters/:charId/select` | 选定某版立绘（仅卡点态） |
| POST `/api/projects/:id/characters/:charId/regenerate` | 改描述重出 3 版（每角色 ≤3 轮） |
| PUT `/api/projects/:id/locations/:locId/select` · POST `.../regenerate` | 地点场景卡同理 |
| POST `/api/projects/:id/characters/confirm` | 卡点放行，进入分镜工作台 |
| POST `/api/projects/:id/scenes/:sceneId/clip` | 逐场手动出视频片段（r2v 参考图直出 + 自动补配音） |
| POST `/api/projects/:id/scenes/:sceneId/regenerate` | 单场重画（不限次数） |
| POST `/api/projects/:id/export` · POST `/api/projects/:id/resume` | 导出成片 / 失败恢复 |

一致性保证：选定的立绘与场景图直接作为 r2v 的 `reference_image` 喂给模型（图1=场景图、图2..N=角色立绘），prompt 中的「图N」编号与 media 数组顺序严格同源产出。

## 仓库结构

```
packages/
  renderer/   @pb/renderer  PixiJS v8 渲染引擎：SceneSpec/BookSpec schema、动效预设、
              BookPlayer 预览、离线逐帧 renderFrames、headless harness
  ai-core/    @pb/ai-core   Provider 接口 + Fake 全套（仅测试桩）+ 真实适配器
              （OpenAI 兼容文本 / 百炼图像·视频·TTS）、story 与 script schema、
              音色板（voices.ts）、wav 工具
apps/
  server/     @pb/server    Fastify：两条产线各自的状态机管线、串行队列、SSE、REST、
              headless 片段渲染、逐页旁白 TTS、ffmpeg 混音拼接导出；
              公共层 clip-join（两条产线共用拼接核）、run-pool（并发池）
  web/        @pb/web       React 18 + Vite：创作表单、SSE 进度、PixiJS 预览、
              音色确认页、逐页回放试听、导出下载；故事视频工作台
```

## 关键设计决策

- **预览即导出**：浏览器预览与成片消费同一份 BookSpec、同一套渲染代码。
- **Provider 可替换**：管线只依赖 `ProviderBundle` 接口，测试注入 Fake 桩零改动。
- **绘本用插画动画而非图生视频**：早期实验发现插画喂给视频模型后画面与插画脱节，故绘本产线统一由 PixiJS headless 逐帧渲染插画产片段；图生视频能力只归故事视频产线使用。
- **人工停靠点是状态机一等公民**：`voice_review`（绘本）与 `awaiting_character_confirmation` / `storyboard_review`（故事视频）把暂停做成显式状态——因为每个下游步骤都花真金白银。
- **时长事实源是片段帧数**：成片时长 = Σ max(片段时长, 旁白所需时长)，禁止用名义 `duration_ms` 推边界，避免音画漂移。
- **两条产线独立而非泛化合并**：故事视频产线另起状态机与记录类型，只下沉真正共用的部分（clip-join、run-pool、泛型 EventHub），避免绘本管线回归风险。

## 开发

```bash
pnpm test          # 四包共 379 个单元/集成测试（全部零网络）
pnpm typecheck     # 全量类型检查
pnpm --filter @pb/web test:e2e   # 全链路 e2e（独立端口 8788/5174，不冲突手动服务）
```

真实供应商行为用 fixture + 注入 fetch 锁定；e2e 经 `PB_PROVIDERS=fake` 注入确定性桩。

重新生成内置素材（均已提交入库，仅音色板/音效清单变更时需要）：

```bash
pnpm --filter @pb/server exec tsx scripts/gen-voice-demos.ts        # 24 个音色试听 wav
ELEVENLABS_API_KEY=*** pnpm --filter @pb/server exec tsx scripts/gen-sfx-elevenlabs.ts  # 33 种音效
```

（钢琴卡农 BGM 由 `apps/server/src/export/bgm.ts` 按需合成并缓存到 `<DATA_DIR>/bgm/`，无需脚本。）

## 常见问题

- **启动即报 `missing required env`**：按提示补齐 `.env` 的四个 `*_API_KEY`（fail-fast 是有意设计）。
- **导出报 `ffmpeg exit …`**：确认 ffmpeg ≥ 7 在 PATH 中；错误尾部的 stderr 会给出具体原因。
- **成片某页无声**：旁白在「制作视频」阶段自动合成；该页 TTS 失败（缩略图标 `!`）则无声但不阻塞成片，重跑该阶段可重试。
- **生成耗时/CPU 高**：逐页文生图 10 并发；片段渲染按 `PB_HARNESS_PAGES`（默认 3）个 browser page 并行；1080p 嫌慢可用 `PB_PAGE_SIZE=320x180` 快速验证链路。
- **PixiJS 不能在同一个 canvas 上二次初始化**（会死锁 WebGL 上下文）：代码中所有重建路径都已规避，改渲染相关代码时务必保持。

## 贡献

欢迎贡献。非琐碎改动请先开 issue 对齐范围。保持 `pnpm test` 与 `pnpm typecheck` 全绿；注释风格跟随现有代码（本仓库注释以中文为主）。

## 许可证

本项目基于 [Apache License, Version 2.0](LICENSE) 授权。

## 致谢

构建于 [PixiJS v8](https://pixijs.com)、[Fastify](https://fastify.dev)、[React](https://react.dev)、[Vite](https://vite.dev)、[Zod](https://zod.dev) 与 [Playwright](https://playwright.dev) 之上。AI 能力经由 DeepSeek、阿里云百炼（Qwen 文本/图像/视频/TTS）与 ElevenLabs（音效素材）提供。默认 BGM 为对帕赫贝尔《D 大调卡农》（公版曲目）的原创离线合成钢琴版本。
