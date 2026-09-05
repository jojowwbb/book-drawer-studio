export type BookLang = 'zh' | 'en';
export type BookFormat = 'landscape' | 'portrait';
export type BookStyle =
  | 'watercolor'
  | 'flat'
  | 'cartoon'
  | 'crayon'
  | 'anime'
  | 'chibi'
  | 'ghibli'
  | 'colored-pencil'
  | 'collage'
  | 'gouache';

/** 故事视频产线的视频风格预设（与绘本画风独立选择） */
export type ProjectStyle = 'realistic-3d' | 'anime' | 'fantasy-picturebook' | 'inkwash';

export interface CreateBookInput {
  theme: string;
  /** 用户主动输入的书名（可选）：留空则由 AI 生成 */
  title?: string;
  style: BookStyle;
  lang: BookLang;
  /** 画幅：横版 16:9（默认）/ 竖版 9:16 */
  format?: BookFormat;
  enhance: boolean;
  /** 背景音乐开关：false=成片不混 BGM（缺省开启） */
  bgm?: boolean;
}

/** 音色确认暂停点（voice_review）返回的角色条目 */
export interface ReviewCharacter {
  name: string;
  appearance_desc: string;
  voice: string | null;
}

export interface BookProgress {
  pages_done: number;
  pages_total: number;
}

export interface ExportArtifact {
  url: string;
  duration_ms: number;
  size_bytes: number;
}

export interface PageClipInfo {
  page_id: string;
  narration_url?: string;
  /** 插画生成/审核多次失败后以占位图跳过：可单独重画 */
  image_failed?: boolean;
}

export interface BookStatus {
  book_id: string;
  state: string;
  progress: BookProgress;
  error?: string;
  preview?: { book_specs: Record<string, string> };
  exports?: Partial<Record<BookLang, ExportArtifact>>;
  clips?: PageClipInfo[];
  /** 停在 voice_review 时携带：待确认的角色列表与旁白音色 */
  voice_review?: { characters: ReviewCharacter[]; narrator_voice: string | null };
}
