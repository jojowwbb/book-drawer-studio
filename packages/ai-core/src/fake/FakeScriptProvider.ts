import type { ScriptAnalysis, ScriptEpisode, ScriptLocation, ScriptScene } from '../script-schema';
import type { ScriptProvider, ScriptRequest, StyleId } from '../types';
import { NARRATOR } from '../voices';

const STYLE_ANCHORS: Record<StyleId, string> = {
  watercolor: '暖色水彩手绘，柔和笔触，纸张纹理',
  flat: '现代扁平插画，干净几何造型，明快配色',
  cartoon: '明亮卡通插画，粗黑描边，高饱和色彩',
  crayon: '蜡笔涂鸦卡通，稚拙粗线条，鲜艳色块',
  anime: '日系动画插画，干净线条，柔和赛璐璐上色',
  chibi: 'Q版chibi卡通，大头小身超变形造型',
  ghibli: '吉卜力风格手绘动画插画，柔和自然光',
  'colored-pencil': '彩色铅笔手绘插画，细腻颗粒质感',
  collage: '纸质拼贴剪纸插画，层叠色块',
  gouache: '水粉厚涂插画，哑光不透明笔触',
  'realistic-3d': '写实 3D 动画渲染风格，电影级布光，逼真材质细节',
  'fantasy-picturebook': '奇幻绘本插画，梦幻瑰丽的光影，童话氛围',
  inkwash: '中国水墨画风格，墨色晕染，留白意境',
};

/**
 * 确定性剧本桩：1 集 4 场 2 角色，每场带旁白 + 隔场角色对白，
 * 覆盖「分角色配音 + 音效 + 关键帧 prompt」链路。
 */
export class FakeScriptProvider implements ScriptProvider {
  readonly name = 'fake-script';

  async analyzeScript(req: ScriptRequest): Promise<ScriptAnalysis> {
    const version = req.reject_reason ? 2 : 1;
    const zh = req.lang === 'zh';
    const hero = zh ? '林小满' : 'Mia';
    const mentor = zh ? '老周' : 'Old Zhou';
    const anchor = STYLE_ANCHORS[req.style];

    const placeZh = ['清晨的港口', '雨后的巷子', '黄昏的天台', '深夜的工作室'];
    const placeEn = ['harbor at dawn', 'alley after rain', 'rooftop at dusk', 'studio late at night'];
    const locations: ScriptLocation[] = placeZh.map((name, i) => ({
      id: `l${i + 1}`,
      name,
      description: zh
        ? `${name}：固定的空间结构与陈设，材质与色调在此锁定（环境资产 ${i + 1}）`
        : `${placeEn[i]}: locked spatial structure, props, materials and palette (location asset ${i + 1})`,
    }));

    const scenes: ScriptScene[] = Array.from({ length: 4 }, (_, i) => {
      const withDialogue = (i + 1) % 2 === 0;
      const narration = zh
        ? `第 ${i + 1} 场：关于「${req.source.slice(0, 12)}」，${hero}往前走了一步，风把故事翻到了下一页。`
        : `Scene ${i + 1}: about "${req.source.slice(0, 12)}", ${hero} took a step forward as the wind turned the page.`;
      return {
        id: `s${i + 1}`,
        title: zh ? `第 ${i + 1} 场` : `Scene ${i + 1}`,
        synopsis: zh
          ? `${hero}在${placeZh[i]!}迎来了本场的转折。`
          : `${hero} faces a turn at the ${placeEn[i]!}.`,
        dialogues: withDialogue
          ? [
              { speaker: NARRATOR, line: zh ? `${mentor}开口道：` : `${mentor} said:` },
              { speaker: mentor, line: zh ? '别怕，往前走。' : 'Dont be afraid, keep going.' },
            ]
          : [],
        location_id: `l${i + 1}`,
        scene_prompt: zh
          ? `主体动作：${hero}站在${placeZh[i]!}中央，侧脸望向远方。环境光影：${['晨光铺在水面', '积水映出霓虹', '晚霞染红天际', '台灯照亮图纸'][i]!}`
          : `Action: ${hero} standing in the center of the ${placeEn[i]!}, looking into the distance. Light: soft ambient glow.`,
        camera: zh ? '镜头缓慢向主体轻微推近' : 'slow push-in toward the subject',
        narration,
        sfx: i === 1 ? [{ type: 'whoosh' as const, at: 0.4 }] : [],
      };
    });

    const episode: ScriptEpisode = {
      id: 'e1',
      title: zh ? '第一集' : 'Episode 1',
      scenes,
    };

    return {
      title: req.title ?? (zh ? `${req.source.slice(0, 8)} v${version}` : `${req.source.slice(0, 8)} v${version}`),
      logline: zh ? '一次告别与一次出发。' : 'A farewell and a departure.',
      style_anchor: anchor,
      lang: req.lang,
      locations,
      characters: [
        {
          id: 'c1',
          name: hero,
          appearance: zh
            ? `二十岁出头的年轻女孩，齐肩黑发，琥珀色眼睛，瘦高身形（主题：${req.source.slice(0, 10)}）`
            : `A young woman in her early twenties with shoulder-length black hair and amber eyes (theme: ${req.source.slice(0, 10)})`,
          costume: zh ? '卡其色风衣、白色帆布鞋' : 'Khaki trench coat, white canvas shoes',
          personality: zh ? '倔强而温柔，习惯把害怕藏在笑里' : 'Stubborn yet tender, hides fear behind a smile',
          voice: zh ? 'Maia' : 'Cherry',
        },
        {
          id: 'c2',
          name: mentor,
          appearance: zh
            ? '五十多岁的中年男人，花白短发，眼角深纹，身材敦实'
            : 'A stocky man in his fifties with greying short hair and deep lines around his eyes',
          costume: zh ? '深蓝色工装外套' : 'Dark blue work jacket',
          personality: zh ? '沉默寡言，关键时刻一锤定音' : 'Quiet, decisive when it matters',
          voice: zh ? 'Arthur' : 'Ethan',
        },
      ],
      episodes: [episode],
    };
  }
}
