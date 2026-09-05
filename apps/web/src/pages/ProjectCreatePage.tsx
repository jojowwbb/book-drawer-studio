import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, createProject } from '../api/project-client';
import type { BookFormat, BookLang, ProjectStyle } from '../api/types';
import { Topbar } from '../components/Steps';
import { listRecentProjects, rememberProject, type RecentProject } from '../lib/storage';
import { stylePreviewUrl } from '../lib/style-previews';

const LANG_OPTIONS: { id: BookLang; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

const FORMAT_OPTIONS: { id: BookFormat; label: string }[] = [
  { id: 'landscape', label: '横版 16:9' },
  { id: 'portrait', label: '竖版 9:16' },
];

const STYLE_OPTIONS: { id: ProjectStyle; label: string }[] = [
  { id: 'realistic-3d', label: '真人3D' },
  { id: 'anime', label: '卡通二次元' },
  { id: 'fantasy-picturebook', label: '奇幻绘本' },
  { id: 'inkwash', label: '水墨国风' },
];

export function ProjectCreatePage(): JSX.Element {
  const navigate = useNavigate();
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState<ProjectStyle>('anime');
  const [lang, setLang] = useState<BookLang>('zh');
  const [format, setFormat] = useState<BookFormat>('landscape');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recent] = useState<RecentProject[]>(() => listRecentProjects());

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = source.trim();
    if (!trimmed) {
      setError('请先输入故事主题，或粘贴整篇文章/小说片段');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const trimmedTitle = title.trim();
      const { project_id } = await createProject({
        source: trimmed,
        title: trimmedTitle || undefined,
        style,
        lang,
        format,
      });
      rememberProject({ id: project_id, source: trimmed, created_at: Date.now() });
      navigate(`/project/${project_id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('内容未通过安全审核，请调整后再试');
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
          { label: '剧本分析', status: 'current' },
          { label: '角色定制', status: 'todo' },
          { label: '分镜与成片', status: 'todo' },
        ]}
      />
      <main className="page">
        <h1>故事视频工坊</h1>
        <p className="subtitle">
          主题文章 → AI 剧本分析 → 角色立绘定制（人工确认）→ 逐场分镜图生视频 → 自动合成成片
        </p>
        <p className="hint">
          产线切换：<Link to="/">绘本工坊</Link> · <strong>故事视频工坊</strong>
        </p>
        <div className="workbench">
          <form
            className="panel"
            onSubmit={(e) => {
              void onSubmit(e);
            }}
          >
            <div className="field">
              <label htmlFor="source">故事主题或整篇文章</label>
              <textarea
                id="source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder={'一句话主题，例如：一个灯塔守夜人与迷路女孩互相救赎的故事\n也可以粘贴整篇文章或小说片段（最多 10000 字），AI 会忠实改编成分集分场的剧本'}
                maxLength={10000}
                rows={8}
              />
              <span className="char-count">{source.length} / 10000</span>
            </div>
            <div className="field">
              <label htmlFor="title">作品名（可选）</label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="留空则由 AI 根据内容生成标题"
                maxLength={50}
              />
              <span className="char-count">{title.length} / 50</span>
            </div>
            <div className="field">
              <span className="field-label">视频风格</span>
              <div className="style-grid" role="radiogroup" aria-label="视频风格选择">
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
            </div>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? '创建中…' : '开始创作'}
            </button>
            <p className="hint">
              剧本分析与角色立绘完成后会停下来等你挑选角色，确认后才开始逐场生成视频，整体耗时较长，可随时离开凭链接回来。
            </p>
          </form>
          <div className="side">
            {recent.length > 0 && (
              <section className="panel">
                <h2>最近的项目</h2>
                <ul className="recent-list">
                  {recent.map((p) => (
                    <li key={p.id}>
                      <Link to={`/project/${p.id}`}>{p.source.slice(0, 20)}</Link>
                      <span className="recent-date">
                        {new Date(p.created_at).toLocaleString('zh-CN')}
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
                    <strong>剧本分析</strong>
                    <p className="hint">AI 把主题/原文改编成分集分场剧本，含角色设定卡与台词</p>
                  </div>
                </li>
                <li>
                  <span className="flow-num">2</span>
                  <div>
                    <strong>角色定制</strong>
                    <p className="hint">每个角色自动出 3 版立绘，你挑选或改描述重出，全员确认后继续</p>
                  </div>
                </li>
                <li>
                  <span className="flow-num">3</span>
                  <div>
                    <strong>分镜与成片</strong>
                    <p className="hint">逐场画关键帧、图生视频、分角色配音，一键拼接导出成片</p>
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
