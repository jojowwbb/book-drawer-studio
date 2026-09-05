import {
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from 'pixi.js';
import type { FrameState } from '../frame';
import type { AmbientState, AmbientItem } from '../presets/ambient';
import type { SceneSpec, Size } from '../schema';

export class SceneView {
  readonly root = new Container();
  private readonly world = new Container();
  private readonly base = new Graphics();
  private subjectSprites: Sprite[] = [];
  private foreground?: Sprite;
  private readonly ambientG = new Graphics();
  private subtitle?: Text;
  private titleOverlay?: Container;

  constructor(private readonly spec: SceneSpec) {
    const { width, height } = spec;
    this.base.rect(0, 0, width, height).fill(spec.base_color);
    this.root.addChild(this.base);
    this.root.addChild(this.world);
  }

  async load(): Promise<void> {
    const spec = this.spec;
    const { width, height } = spec;
    const srcs = [
      spec.background.src,
      ...spec.subjects.map((s) => s.src),
      ...(spec.foreground ? [spec.foreground.src] : []),
    ];
    await Assets.load(srcs);

    const bg = new Sprite(Texture.from(spec.background.src));
    bg.anchor.set(0.5);
    // cover 缩放：保持纹理纵横比放大到覆盖画布（镜头运动需要 1.2x 余量），
    // 避免图像档位与画布比例不一致时（如 3:4 图进 9:16 画布）被硬拉伸
    const tex = bg.texture;
    const cover = 1.2 * Math.max(width / tex.width, height / tex.height);
    bg.scale.set(cover);
    bg.position.set(width / 2, height / 2);
    this.world.addChild(bg);

    this.subjectSprites = spec.subjects.map((s) => {
      const sp = new Sprite(Texture.from(s.src));
      sp.anchor.set(0.5);
      sp.scale.set(s.scale);
      sp.position.set(s.x, s.y);
      this.world.addChild(sp);
      return sp;
    });

    if (spec.foreground) {
      const fg = new Sprite(Texture.from(spec.foreground.src));
      fg.anchor.set(0.5);
      fg.width = width * 1.2;
      fg.height = (fg.texture.height / fg.texture.width) * fg.width;
      fg.position.set(width / 2, height - fg.height / 2 + 4);
      this.foreground = fg;
      this.world.addChild(fg);
    }

    this.world.addChild(this.ambientG);

    if (spec.subtitle) {
      // 字号按高/宽双基准取小：竖版画幅窄，只按高度定字号会溢出画面
      const fontSize = Math.round(Math.min(height / 20, width / 14));
      const text = new Text({
        text: spec.subtitle.text,
        style: new TextStyle({
          fontFamily: 'sans-serif',
          fontSize,
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 4 },
          // 长句自动换行防溢出：中文无空格，需 breakWords 按字符断行
          wordWrap: true,
          wordWrapWidth: Math.round(width * 0.8),
          breakWords: true,
          lineHeight: Math.round(fontSize * 1.3),
          align: 'center',
        }),
      });
      // 底部锚点：多行时向上生长，不会贴出画面下缘
      text.anchor.set(0.5, 1);
      text.position.set(width / 2, Math.round(height * 0.92));
      text.alpha = 0;
      this.subtitle = text;
      this.root.addChild(text);
    }

    if (spec.title_overlay) {
      this.titleOverlay = this.buildTitleOverlay(spec.title_overlay);
      this.titleOverlay.alpha = 0;
      this.root.addChild(this.titleOverlay);
    }
  }

  /** 片头幕：底部渐变压暗保证文字可读，大标题居中偏上，标签胶囊排在底部 */
  private buildTitleOverlay(overlay: NonNullable<SceneSpec['title_overlay']>): Container {
    const { width, height } = this.spec;
    const layer = new Container();

    // 下半幅渐变压暗（多档 alpha 叠矩形近似线性渐变），封面主体在上半部不被遮挡
    const scrim = new Graphics();
    const bands = 24;
    const bandTop = Math.round(height * 0.32);
    const bandH = Math.ceil((height - bandTop) / bands);
    for (let i = 0; i < bands; i++) {
      const t = (i + 1) / bands;
      scrim
        .rect(0, bandTop + i * bandH, width, bandH + 1)
        .fill({ color: 0x101020, alpha: 0.045 * t * t * 2.2 });
    }
    layer.addChild(scrim);

    // 大标题：强制单行不换行，超出可用宽度则逐级缩小字号；水平垂直居中
    const maxTitleW = Math.round(width * 0.9);
    const minTitleFontSize = Math.round(height / 20);
    let titleFontSize = Math.round(Math.min(height / 7, width / 6));
    const title = new Text({
      text: overlay.title,
      style: new TextStyle({
        fontFamily: 'sans-serif',
        fontWeight: '700',
        fontSize: titleFontSize,
        fill: 0xffffff,
        stroke: { color: 0x1c1c2e, width: Math.max(6, Math.round(height / 120)) },
        align: 'center',
      }),
    });
    while (title.width > maxTitleW && titleFontSize > minTitleFontSize) {
      titleFontSize = Math.max(minTitleFontSize, Math.round(titleFontSize * 0.92));
      title.style.fontSize = titleFontSize;
    }
    // 超长标题缩到最小字号仍放不下：等比缩放兜底，保证永不换行/溢出
    const overflow = title.width / maxTitleW;
    if (overflow > 1) title.scale.set(1 / overflow);
    title.anchor.set(0.5, 0.5);
    title.position.set(width / 2, Math.round(height / 2));
    layer.addChild(title);

    let nextBottom = Math.round(title.position.y + title.height / 2 + height * 0.015);
    if (overlay.subtitle) {
      const sub = new Text({
        text: overlay.subtitle,
        style: new TextStyle({
          fontFamily: 'sans-serif',
          fontSize: Math.round(Math.min(height / 22, width / 16)),
          fill: 0xfff3d6,
          stroke: { color: 0x1c1c2e, width: 3 },
          wordWrap: true,
          wordWrapWidth: Math.round(width * 0.8),
          breakWords: true,
          align: 'center',
        }),
      });
      sub.anchor.set(0.5, 0);
      sub.position.set(width / 2, nextBottom);
      layer.addChild(sub);
      nextBottom += sub.height + Math.round(height * 0.02);
    }

    // 标签胶囊：白底半透明圆角矩形 + 文字，超宽自动换行（最多两行）
    const tags = overlay.tags.slice(0, 8);
    if (tags.length > 0) {
      const fontSize = Math.round(Math.min(height / 30, width / 24));
      const padX = Math.round(fontSize * 0.9);
      const gap = Math.round(fontSize * 0.7);
      const pills: { node: Container; w: number }[] = tags.map((tag) => {
        const label = new Text({
          text: tag.startsWith('#') ? tag : `#${tag}`,
          style: new TextStyle({
            fontFamily: 'sans-serif',
            fontWeight: '600',
            fontSize,
            fill: 0x3d2b56,
          }),
        });
        const pill = new Container();
        const w = Math.ceil(label.width) + padX * 2;
        const h = fontSize + Math.round(padX * 0.7);
        pill
          .addChild(new Graphics().roundRect(0, 0, w, h, h / 2).fill({ color: 0xffe9b0, alpha: 0.92 }))
          .addChild(label);
        label.position.set(padX, (h - label.height) / 2);
        return { node: pill, w };
      });
      const maxRowW = Math.round(width * 0.88);
      const rows: { node: Container; w: number }[][] = [[]];
      let rowW = 0;
      for (const pill of pills) {
        if (rows.length < 2 && rowW > 0 && rowW + gap + pill.w > maxRowW) {
          rows.push([pill]);
          rowW = pill.w;
        } else {
          rows[rows.length - 1]!.push(pill);
          rowW += (rowW > 0 ? gap : 0) + pill.w;
        }
      }
      const pillH = Math.round(fontSize * 1.6);
      let y = Math.min(nextBottom + Math.round(height * 0.02), height - pillH - Math.round(height * 0.05));
      for (const row of rows) {
        const totalW = row.reduce((a, p) => a + p.w, 0) + gap * Math.max(0, row.length - 1);
        let x = Math.round((width - totalW) / 2);
        for (const pill of row) {
          pill.node.position.set(x, y);
          x += pill.w + gap;
          layer.addChild(pill.node);
        }
        y += pillH + Math.round(gap * 0.6);
      }
    }
    return layer;
  }

  apply(frame: FrameState): void {
    const { width, height }: Size = this.spec;
    const cam = frame.camera;

    this.world.scale.set(cam.scale);
    this.world.position.set(
      width / 2 - (width / 2) * cam.scale + cam.offsetX,
      height / 2 - (height / 2) * cam.scale + cam.offsetY,
    );

    this.spec.subjects.forEach((s, i) => {
      const sp = this.subjectSprites[i];
      const st = frame.subjects[i];
      if (!sp || !st) return;
      sp.scale.set(s.scale * st.scale);
      sp.rotation = st.rotation;
      sp.position.set(s.x + st.dx, s.y + st.dy);
      sp.alpha = st.alpha;
    });

    if (this.foreground) {
      this.foreground.position.x = width / 2 - cam.offsetX * 0.5;
    }

    this.drawAmbient(frame.ambient);

    if (this.subtitle) this.subtitle.alpha = frame.subtitleAlpha;
    if (this.titleOverlay) this.titleOverlay.alpha = frame.subtitleAlpha;
  }

  private drawAmbient(states: AmbientState[]): void {
    const g = this.ambientG;
    g.clear();
    for (const state of states) {
      for (const item of state.items) {
        this.drawAmbientItem(g, state.type, item);
      }
    }
  }

  private drawAmbientItem(
    g: Graphics,
    type: AmbientState['type'],
    item: AmbientItem,
  ): void {
    switch (type) {
      case 'stars_twinkle':
        g.circle(item.x, item.y, item.size).fill({ color: 0xfff3c4, alpha: item.alpha });
        break;
      case 'fireflies':
        g.circle(item.x, item.y, item.size).fill({ color: 0xd8f76b, alpha: item.alpha });
        break;
      case 'snow':
        g.circle(item.x, item.y, item.size).fill({ color: 0xffffff, alpha: item.alpha });
        break;
      case 'rain':
        g.moveTo(item.x, item.y)
          .lineTo(item.x - 2, item.y + item.size)
          .stroke({ width: 1.5, color: 0xbcd2f0, alpha: item.alpha });
        break;
      case 'clouds_drift': {
        // 三团错落的椭圆叠出蓬松棉絮感，避免单个硬边大椭圆像画面上的白雾污渍
        const { x, y, size, alpha } = item;
        g.ellipse(x, y, size, size * 0.42).fill({ color: 0xffffff, alpha });
        g.ellipse(x - size * 0.55, y + size * 0.1, size * 0.62, size * 0.3).fill({ color: 0xffffff, alpha });
        g.ellipse(x + size * 0.55, y + size * 0.08, size * 0.58, size * 0.28).fill({ color: 0xffffff, alpha });
        break;
      }
      case 'light_rays':
        g.rect(0, 0, this.spec.width, this.spec.height).fill({
          color: 0xffe9b0,
          alpha: item.alpha,
        });
        break;
    }
  }

  setAlpha(alpha: number): void {
    this.root.alpha = alpha;
  }

  destroy(): void {
    this.root.destroy({ children: true, texture: false });
  }
}
