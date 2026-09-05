import type { BookSpec } from '@pb/renderer';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { editPageText, exportBook, pollUntilState, redubBook, regeneratePage } from '../api/client';
import type { BookLang, BookStatus, PageClipInfo } from '../api/types';
import { BookPlayerCanvas, type BookPlayerHandle } from '../components/BookPlayerCanvas';
import { loadBookSpec } from '../lib/spec';

interface ClipState {
  phase: 'generating' | 'failed';
  error?: string;
}

interface PreviewPaneProps {
  status: BookStatus;
  narrationStates?: Record<string, ClipState>;
  narrationVersions?: Record<string, number>;
  clipVersions?: Record<string, number>;
}

const LANG_LABELS: Record<BookLang, string> = {
  zh: '中文',
  en: 'English',
};

/** 片头幕在 BookSpec 里的 page_id（不在 status.clips 清单中，旁白事件仍按此 id 发） */
const TITLE_PAGE_ID = 'title';

export function PreviewPane({
  status,
  narrationStates = {},
  narrationVersions = {},
  clipVersions = {},
}: PreviewPaneProps): JSX.Element {
  const specUrls = status.preview?.book_specs ?? {};
  const availableLangs = (Object.keys(specUrls) as BookLang[]).filter((l) => specUrls[l]);
  // 语言跟随实际产物：单选语言模式下只有一种语言，缺省 zh 会导致英文书预览空白
  const [langState, setLang] = useState<BookLang | null>(null);
  const lang = availableLangs.includes(langState as BookLang) ? (langState as BookLang) : availableLangs[0] ?? 'zh';
  const [spec, setSpec] = useState<BookSpec | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [activePage, setActivePage] = useState(0);
  const [regenRemaining, setRegenRemaining] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  // 文案编辑：改本页旁白（片头幕改标题/副标题/标签），保存后等该页语音与片段重做
  const [editing, setEditing] = useState(false);
  const [draftNarration, setDraftNarration] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftSubtitle, setDraftSubtitle] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** 保存时刻的 clipVersions 基线：版本增加即代表该页片段重渲染完成 */
  const [saveBaseVersion, setSaveBaseVersion] = useState<Record<string, number>>({});
  const playerRef = useRef<BookPlayerHandle>(null);

  const specUrl = specUrls[lang];
  const totalPages = spec?.pages.length ?? 0;
  const exporting = status.state === 'exporting';
  const exports = status.exports;
  const clipsById = new Map<string, PageClipInfo>((status.clips ?? []).map((c) => [c.page_id, c]));
  // 重新配音进行中：任意页处于 generating（SSE page_narration 驱动）
  const redubbing = Object.values(narrationStates).some((s) => s.phase === 'generating');

  const reload = useCallback(async (url: string): Promise<void> => {
    // 先卸载旧播放器（spec 置 null）：pixi 不能在已销毁上下文的 canvas 上重建，
    // 必须保证每个 BookPlayer 实例都拿到全新的 canvas 元素
    setSpec(null);
    setSpecError(null);
    try {
      setSpec(await loadBookSpec(url));
    } catch (e) {
      setSpec(null);
      setSpecError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!specUrl) return;
    void reload(specUrl);
  }, [specUrl, reload]);

  const activePageId = spec?.pages[activePage]?.page_id;
  const isTitlePage = activePageId === TITLE_PAGE_ID;
  const activeScene = spec?.pages[activePage];

  // 文案编辑保存后：等该页片段重渲染完成（page_clip ready → clipVersions +1）再重载 spec 并退出编辑
  useEffect(() => {
    if (!saving || !activePageId) return;
    if ((clipVersions[activePageId] ?? 0) > (saveBaseVersion[activePageId] ?? 0)) {
      setSaving(false);
      setEditing(false);
      if (specUrl) void reload(specUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipVersions, saving, activePageId]);

  // 旁白失败也要退出等待（narration failed 不会再有 clip ready）
  useEffect(() => {
    if (!saving || !activePageId) return;
    if (narrationStates[activePageId]?.phase === 'failed') {
      setSaving(false);
      setEditError(narrationStates[activePageId]?.error ?? '旁白合成失败');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrationStates, saving, activePageId]);

  const startEdit = useCallback(() => {
    if (!activeScene) return;
    setEditError(null);
    if (activeScene.title_overlay) {
      setDraftTitle(activeScene.title_overlay.title);
      setDraftSubtitle(activeScene.title_overlay.subtitle ?? '');
      setDraftTags(activeScene.title_overlay.tags.join('、'));
    } else {
      setDraftNarration(activeScene.subtitle?.text ?? '');
    }
    setEditing(true);
  }, [activeScene]);

  const onSaveText = useCallback(async () => {
    if (!status.book_id || !activePageId) return;
    setEditError(null);
    const patch: { narration?: string; cover?: { title?: string; subtitle?: string; tags?: string[] } } = {};
    if (isTitlePage) {
      const title = draftTitle.trim();
      if (!title) {
        setEditError('大标题不能为空');
        return;
      }
      patch.cover = {
        title,
        subtitle: draftSubtitle.trim() || undefined,
        tags: draftTags
          .split(/[、,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      };
    } else {
      const narration = draftNarration.trim();
      if (!narration) {
        setEditError('旁白不能为空');
        return;
      }
      patch.narration = narration;
    }
    setSaving(true);
    setSaveBaseVersion((m) => ({ ...m, [activePageId]: clipVersions[activePageId] ?? 0 }));
    try {
      await editPageText(status.book_id, activePageId, patch);
    } catch (e) {
      setSaving(false);
      setEditError(e instanceof Error ? e.message : String(e));
    }
  }, [status.book_id, activePageId, isTitlePage, draftTitle, draftSubtitle, draftTags, draftNarration, clipVersions]);

  const goToPage = useCallback(
    (index: number) => {
      const clamped = Math.min(Math.max(0, index), Math.max(0, totalPages - 1));
      setActivePage(clamped);
      playerRef.current?.seekPage(clamped);
    },
    [totalPages],
  );

  const onRegenerate = useCallback(async () => {
    if (!status.book_id || !activePageId) return;
    setRegenerating(true);
    try {
      const { remaining } = await regeneratePage(status.book_id, activePageId);
      setRegenRemaining(remaining);
      await pollUntilState(status.book_id, ['ready'], { timeoutMs: 60000 });
      if (specUrl) await reload(specUrl);
    } catch (e) {
      setSpecError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
    }
  }, [status.book_id, activePageId, specUrl, reload]);

  const onExport = useCallback(async () => {
    if (!status.book_id) return;
    setExportError(null);
    try {
      await exportBook(status.book_id);
      // 后续 exporting/completed 状态与产物由 SSE 带回，无需轮询
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  }, [status.book_id]);

  const activeClip = activePageId ? clipsById.get(activePageId) : undefined;
  // 片头幕不在 clips 清单里：旁白回放地址从 status 轮询后由 page_narration 事件补进 narrationUrl
  const narrationState = activePageId ? narrationStates[activePageId] : undefined;

  // 切页时清掉上一页的片段错误提示与编辑态
  useEffect(() => {
    setClipError(null);
    setEditing(false);
    setEditError(null);
  }, [activePageId]);

  const onRedub = useCallback(async () => {
    if (!status.book_id) return;
    setClipError(null);
    try {
      await redubBook(status.book_id);
      // 逐页 generating/ready 由 SSE page_narration 事件带回
    } catch (e) {
      setClipError(e instanceof Error ? e.message : String(e));
    }
  }, [status.book_id]);

  return (
    <section
      className="preview"
      style={
        spec
          ? ({ '--pb-ar': (spec.pages[0]!.width / spec.pages[0]!.height).toFixed(4) } as CSSProperties)
          : undefined
      }
    >
      <div className="toolbar">
        {availableLangs.length > 1 && (
          <div className="seg" role="group" aria-label="预览语言">
            {availableLangs.map((l) => (
              <button
                key={l}
                type="button"
                className={lang === l ? 'seg-item active' : 'seg-item'}
                aria-pressed={lang === l}
                onClick={() => setLang(l)}
              >
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        )}
        <span className="clip-source">
          {totalPages > 0 ? `共 ${totalPages} 页` : ''}
        </span>
        <div className="toolbar-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void onRegenerate();
            }}
            disabled={regenerating || redubbing || regenRemaining === 0 || !activePageId}
          >
            {regenerating ? '重画中…' : '重画这一页'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void onRedub();
            }}
            disabled={redubbing || exporting}
            title="按分角色配音规则重新合成全书旁白（补齐对白间的旁白过渡句），不重画插画"
          >
            {redubbing ? '配音中…' : '重新配音'}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={exporting || redubbing || !!exports}
            onClick={() => {
              void onExport();
            }}
          >
            {exporting ? '导出中…' : '导出视频'}
          </button>
        </div>
      </div>
      {exportError && (
        <p className="error-text" role="alert">
          {exportError}
        </p>
      )}
      <div className="preview-layout">
        <div className="panel player-panel">
          {spec && (
            <BookPlayerCanvas ref={playerRef} spec={spec} autoPlay onActivePageChange={setActivePage} />
          )}
          {spec && activePageId && (
            <div className="clip-bar">
              <button
                type="button"
                className="btn-secondary btn-small"
                disabled={editing || saving || exporting || redubbing}
                onClick={startEdit}
                title={isTitlePage ? '修改片头大标题、副标题与标签，自动重配语音并重渲染片头' : '修改本页旁白，自动重配语音并重渲染字幕（不重画插画）'}
              >
                {isTitlePage ? '编辑片头文案' : '编辑旁白'}
              </button>
              {activeClip?.image_failed && (
                <span className="error-text" role="alert">
                  本页插画生成失败，暂用占位图——点上方「重画这一页」单独重新生成
                </span>
              )}
              {narrationState?.phase === 'failed' && (
                <span className="error-text" role="alert">
                  旁白生成失败：{narrationState.error ?? '未知错误'}
                </span>
              )}
              {clipError && (
                <span className="error-text" role="alert">
                  {clipError}
                </span>
              )}
            </div>
          )}
          {editing && (
            <div className="text-edit-form">
              {isTitlePage ? (
                <>
                  <label className="field">
                    <span>大标题</span>
                    <input
                      type="text"
                      value={draftTitle}
                      maxLength={50}
                      onChange={(e) => setDraftTitle(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>副标题（可留空）</span>
                    <input
                      type="text"
                      value={draftSubtitle}
                      maxLength={60}
                      onChange={(e) => setDraftSubtitle(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>标签（顿号分隔）</span>
                    <input
                      type="text"
                      value={draftTags}
                      onChange={(e) => setDraftTags(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label className="field">
                  <span>本页旁白（配音与字幕同源）</span>
                  <textarea
                    rows={3}
                    value={draftNarration}
                    maxLength={200}
                    onChange={(e) => setDraftNarration(e.target.value)}
                  />
                </label>
              )}
              <div className="text-edit-actions">
                <button
                  type="button"
                  className="btn-primary btn-small"
                  disabled={saving}
                  onClick={() => {
                    void onSaveText();
                  }}
                >
                  {saving ? '重配语音并渲染中…' : '保存并重新配音'}
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false);
                    setEditError(null);
                  }}
                >
                  取消
                </button>
              </div>
              {editError && (
                <p className="error-text" role="alert">
                  {editError}
                </p>
              )}
            </div>
          )}
          {spec && activeClip?.narration_url && (
            <div className="narration-bar">
              <span className="clip-source">本页旁白：</span>
              <audio
                controls
                preload="none"
                src={`${activeClip.narration_url}?v=${narrationVersions[activePageId ?? ''] ?? 0}`}
                aria-label="本页旁白回放"
              />
            </div>
          )}
          {exports && (() => {
            const first = exports.zh ?? Object.values(exports)[0];
            return first ? (
              <div className="export-result">
                <video controls className="preview-video" src={first.url} />
                <a className="btn-secondary" href={first.url} download>
                  下载视频
                </a>
              </div>
            ) : null;
          })()}
          {(specError || status.error) && (
            <p className="error-text" role="alert">
              {specError ?? status.error}
            </p>
          )}
          {regenRemaining !== null && <p className="hint">本页还可重画 {regenRemaining} 次</p>}
        </div>
        <aside className="panel storyboard">
          <div className="panel-head">
            <h2 className="panel-title">
              故事分镜
              <span className="panel-sub">（共 {totalPages} 页）</span>
            </h2>
            <span className="page-indicator">
              {totalPages > 0 ? `${activePage + 1} / ${totalPages}` : '—'}
            </span>
          </div>
          {spec && (
            <div className="thumbs" role="listbox" aria-label="页面缩略图">
              {spec.pages.map((p, i) => {
                const info = clipsById.get(p.page_id);
                const narrState = narrationStates[p.page_id];
                return (
                  <button
                    key={p.page_id}
                    type="button"
                    role="option"
                    aria-selected={i === activePage}
                    className={i === activePage ? 'thumb active' : 'thumb'}
                    style={{ backgroundImage: `url(${p.background.src})` }}
                    onClick={() => goToPage(i)}
                  >
                    <span>{i + 1}</span>
                    {info?.image_failed && <em className="thumb-badge fail">图</em>}
                    {narrState?.phase === 'generating' && <em className="thumb-badge">配…</em>}
                    {narrState?.phase === 'failed' && <em className="thumb-badge fail">!</em>}
                    {!narrState && info?.narration_url && (
                      <em className="thumb-badge voice">音</em>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
