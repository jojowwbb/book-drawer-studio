import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, createBook } from '../api/client';
import type { BookFormat, BookLang, BookStyle } from '../api/types';
import { Topbar } from '../components/Steps';
import { listRecentBooks, rememberBook, type RecentBook } from '../lib/storage';
import { stylePreviewUrl } from '../lib/style-previews';

const LANG_OPTIONS: { id: BookLang; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

const FORMAT_OPTIONS: { id: BookFormat; label: string }[] = [
  { id: 'landscape', label: '横版 16:9' },
  { id: 'portrait', label: '竖版 9:16' },
];

const STYLE_OPTIONS: { id: BookStyle; label: string }[] = [
  { id: 'watercolor', label: '暖色水彩' },
  { id: 'flat', label: '现代扁平' },
  { id: 'cartoon', label: '明亮卡通' },
  { id: 'crayon', label: '蜡笔涂鸦' },
  { id: 'anime', label: '日系动画' },
  { id: 'chibi', label: 'Q版chibi' },
  { id: 'ghibli', label: '吉卜力手绘' },
  { id: 'colored-pencil', label: '彩铅粉彩' },
  { id: 'collage', label: '拼贴剪纸' },
  { id: 'gouache', label: '水粉厚涂' },
];

export function CreatePage(): JSX.Element {
  const navigate = useNavigate();
  const [theme, setTheme] = useState('');
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState<BookStyle>('watercolor');
  const [lang, setLang] = useState<BookLang>('zh');
  const [format, setFormat] = useState<BookFormat>('landscape');
  const [enhance, setEnhance] = useState(false);
  const [bgm, setBgm] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recent] = useState<RecentBook[]>(() => listRecentBooks());

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = theme.trim();
    if (!trimmed) {
      setError('请先输入故事主题，或粘贴一整篇故事文章');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const trimmedTitle = title.trim();
      const { book_id } = await createBook({
        theme: trimmed,
        title: trimmedTitle || undefined,
        style,
        lang,
        format,
        enhance,
        bgm,
      });
      rememberBook({ id: book_id, theme: trimmed, created_at: Date.now() });
      navigate(`/book/${book_id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('主题未通过安全审核，请换一个更温和的主题');
      } else {
        setError('创建失败，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Topbar
        steps={[
          { label: '故事创作', status: 'current' },
          { label: '插画与配音', status: 'todo' },
          { label: '绘本预览与导出', status: 'todo' },
        ]}
      />
      <main className="page">
        <h1>绘本工坊</h1>
        <p className="subtitle">一句话主题或整篇文章，选一种语言，生成一本会动的绘本故事视频</p>
        <p className="hint">
          产线切换：<strong>绘本工坊</strong> · <Link to="/project/create">故事视频工坊</Link>
        </p>
        <div className="workbench">
          <form
            className="panel"
            onSubmit={(e) => {
              void onSubmit(e);
            }}
          >
            <div className="field">
              <label htmlFor="theme">故事主题或整篇文章</label>
              <textarea
                id="theme"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                placeholder={'一句话主题，例如：孩子怕黑，不敢一个人睡觉\n也可以粘贴一整篇故事文章（最多 10000 字），我们会忠实于原文改编成绘本'}
                maxLength={10000}
                rows={6}
              />
              <span className="char-count">{theme.length} / 10000</span>
            </div>
            <div className="field">
              <label htmlFor="title">书名（可选）</label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="留空则由 AI 根据内容生成爆款书名与片头标题"
                maxLength={50}
              />
              <span className="char-count">{title.length} / 50</span>
            </div>
            <div className="field">
              <span className="field-label">画风</span>
              <div className="style-grid" role="radiogroup" aria-label="画风选择">
                {STYLE_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={style === o.id}
                    className={style === o.id ? 'style-card active' : 'style-card'}
                    onClick={() => setStyle(o.id)}
                  >
                    <span className="style-thumb">
                      <img src={stylePreviewUrl(o.id)} alt={`${o.label}画风预览`} loading="lazy" />
                      {style === o.id && <em className="style-check" aria-hidden>✓</em>}
                    </span>
                    <span className="style-name">{o.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">语言</span>
              <div className="seg" role="radiogroup" aria-label="语言选择">
                {LANG_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={lang === o.id ? 'seg-item active' : 'seg-item'}
                    aria-pressed={lang === o.id}
                    onClick={() => setLang(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">画幅</span>
              <div className="seg" role="radiogroup" aria-label="画幅选择">
                {FORMAT_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={format === o.id ? 'seg-item active' : 'seg-item'}
                    aria-pressed={format === o.id}
                    onClick={() => setFormat(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <span className="char-count">竖版适配抖音/视频号，插画按竖向构图生成</span>
            </div>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={bgm}
                onChange={(e) => setBgm(e.target.checked)}
              />
              <span>背景音乐（关闭则成片只保留旁白与音效，不混入 BGM）</span>
            </label>
            {/* <label className="switch-row">
              <input
                type="checkbox"
                checked={enhance}
                onChange={(e) => setEnhance(e.target.checked)}
              />
              <span>高潮页动画增强（演示模式暂无差异）</span>
            </label> */}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? '创建中…' : '开始创作'}
            </button>
            <p className="hint">
              生成通常需要 3-6 分钟（真实 AI 模式）；演示模式一般 1 分钟内完成。生成期间可以离开页面，稍后凭链接回来继续。
            </p>
          </form>
          <div className="side">
            {recent.length > 0 && (
              <section className="panel">
                <h2>最近的作品</h2>
                <ul className="recent-list">
                  {recent.map((b) => (
                    <li key={b.id}>
                      <Link to={`/book/${b.id}`}>{b.theme.slice(0, 20)}</Link>
                      <span className="recent-date">
                        {new Date(b.created_at).toLocaleString('zh-CN')}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="panel">
              <h2>创作流程</h2>
              <ol className="flow-list">
                <li>
                  <span className="flow-num">1</span>
                  <div>
                    <strong>故事创作</strong>
                    <p className="hint">AI 按主题或原文分幕编写绘本故事与旁白文案</p>
                  </div>
                </li>
                <li>
                  <span className="flow-num">2</span>
                  <div>
                    <strong>插画与配音</strong>
                    <p className="hint">逐页文生图绘制插画，并按所选语言合成旁白语音</p>
                  </div>
                </li>
                <li>
                  <span className="flow-num">3</span>
                  <div>
                    <strong>绘本预览与导出</strong>
                    <p className="hint">逐页动画预览、单页重画，一键导出带旁白的 MP4</p>
                  </div>
                </li>
              </ol>
            </section>
          </div>
        </div>
      </main>
      <footer className="disclaimer">
        <span aria-hidden>ⓘ</span> AI 生成的内容仅供参考，请注意核对和修改
      </footer>
    </>
  );
}
