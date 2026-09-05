import type { BookStyle, ProjectStyle } from '../api/types';

/**
 * 画风预览图：统一以「阳光下森林里的白色小兔子」为题材，
 * 仅画风不同，方便用户横向对比各风格差异。
 *
 * 图片固化在 `public/style-previews/`（此前为外部 text_to_image 服务
 * 运行时动态生成，该服务对新 prompt 已停止出图，故改为本地静态资源）。
 */
export function stylePreviewUrl(style: BookStyle | ProjectStyle): string {
  return `/style-previews/${style}.jpg`;
}
