/**
 * 用 DashScope Qwen-TTS 为 VOICE_PALETTE 全部音色预生成试听 demo，
 * 落到 apps/web/public/voice-demos/<slug>.wav（前端静态资源，免运行时依赖外部服务）。
 *
 * 一次性运行（需 TTS_API_KEY，与产线共用）：
 *   pnpm --filter @pb/server exec tsx scripts/gen-voice-demos.ts
 *
 * 可选参数（env）：
 *   PB_VOICE_DEMO_IDS="Bella Cherry"   只生成指定音色（默认全部）
 *   PB_VOICE_DEMO_FORCE=1              覆盖已存在的文件重新生成
 *
 * 前端通过 /voice-demos/<slug>.wav 引用；slug 见 voiceDemoSlug()。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  createRealProviders,
  loadRealProvidersConfig,
  loadRepoEnvFile,
  VOICE_PALETTE,
} from '@pb/ai-core';

loadRepoEnvFile(import.meta.url);

const API_KEY = process.env.TTS_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
if (!API_KEY) {
  console.error('缺少 TTS_API_KEY（或 DASHSCOPE_API_KEY）环境变量');
  process.exit(1);
}

const OUT_DIR = new URL('../../web/public/voice-demos/', import.meta.url).pathname;

/** 音色 id → 文件名 slug（音色名含空格，如 "Eldric Sage"） */
export function voiceDemoSlug(voice: string): string {
  return voice.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * 每个音色的试听文本：贴合该音色的绘本适用角色，一两句话即可听出质感。
 * 未单独编写的用通用兜底句。
 */
const DEMO_TEXTS: Record<string, string> = {
  Bella: '妈妈妈妈，你看你看，天上有一颗小星星在对我眨眼睛呢！',
  Bunny: '嘿嘿，我是小兔子蹦蹦，我最喜欢吃胡萝卜啦！',
  Nini: '哥哥，你轻一点好不好？小猫咪睡觉的时候，最怕吵啦。',
  Mia: '我把小红花种在窗台上，每天给它喝一点点水，它就笑了。',
  Stella: '别怕，有我在呢！我们一起把迷路的小鸭子送回家。',
  Mochi: '我知道我知道！月亮晚上出来，是因为它怕黑，要找星星做朋友。',
  Pip: '冲呀——！谁也别想拦住我去找宝藏！',
  Cherry: '小朋友，今天过得开心吗？来，坐在姐姐身边，我们讲个故事吧。',
  Serena: '宝贝，该睡觉啦。妈妈给你盖上小被子，做个甜甜的梦哦。',
  Maia: '你知道吗？大海的深处，住着一只会唱歌的蓝色鲸鱼。',
  Seren: '风轻轻地吹，云慢慢地走，小花也闭上了眼睛。',
  Chelsie: '哇，好厉害呀！我也想像你一样，变成勇敢的小魔法师！',
  Momo: '哎呀呀，我的小尾巴怎么不见啦？大家快帮我找找嘛！',
  Vivian: '哼，这个南瓜灯是我做的，才、才不是为了等你来看呢。',
  Bellona: '且听我细细道来——这山洞里啊，藏着一只千年老狐狸！',
  Ethan: '儿子，勇敢往前走！摔倒了没关系，爸爸在后面扶着你呢。',
  Moon: '怕什么？黑夜里的路，我走过一百遍了，跟紧我。',
  Kai: '累了就休息一会儿吧，星星会替你守着这片森林的。',
  Vincent: '想当年，爷爷我背着行囊，翻过三座大山，才找到这个宝贝！',
  Nofish: '哎呀，好困呐……这事儿嘛，明天……再说吧……',
  Neil: '各位观众朋友，晚上好！欢迎收听睡前故事时间。',
  Elias: '让我们从头说起：很久很久以前，在一座开满鲜花的山谷里……',
  Arthur: '从前啊，有座老磨坊，磨坊里住着一个爱讲故事的老爷爷。',
  'Eldric Sage': '孩子，慢下来，听风说话。答案啊，就在你心里。',
};

const FALLBACK_TEXT = '你好呀，我是你的故事伙伴。今晚，我们一起去森林里散散步吧。';

async function main(): Promise<void> {
  const { tts } = createRealProviders(loadRealProvidersConfig(process.env));
  if (!tts) {
    console.error('供应商集合缺少 tts');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const filter = process.env.PB_VOICE_DEMO_IDS?.trim().split(/\s+/).filter(Boolean);
  const force = process.env.PB_VOICE_DEMO_FORCE === '1';
  const voices = filter?.length ? filter : Object.keys(VOICE_PALETTE);

  let done = 0;
  let skipped = 0;
  for (const voice of voices) {
    if (!(voice in VOICE_PALETTE)) {
      console.warn(`[skip] 未知音色：${voice}`);
      continue;
    }
    const path = `${OUT_DIR}${voiceDemoSlug(voice)}.wav`;
    if (existsSync(path) && !force) {
      skipped++;
      continue;
    }
    const text = DEMO_TEXTS[voice] ?? FALLBACK_TEXT;
    try {
      const { audio } = await tts.synthesize({ text, lang: 'zh', voice });
      writeFileSync(path, audio);
      done++;
      console.log(`[ok] ${voice} -> ${voiceDemoSlug(voice)}.wav (${(audio.byteLength / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`[fail] ${voice}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`完成：新生成 ${done}，跳过已存在 ${skipped}，目录 ${OUT_DIR}`);
}

void main();
