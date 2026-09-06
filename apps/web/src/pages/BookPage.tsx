import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getBook, resumeBook } from '../api/client';
import type { BookStatus } from '../api/types';
import { CharacterReview } from '../components/CharacterReview';
import { Topbar, type StepDef } from '../components/Steps';
import { useBookStream } from '../hooks/useBookStream';
import { stateLabel } from '../lib/labels';
import { PreviewPane } from './PreviewPane';

export function BookPage(): JSX.Element | null {
  const { id = '' } = useParams();
  const [initial, setInitial] = useState<BookStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInitial(null);
    setLoadError(null);
    getBook(id)
      .then((s) => {
        if (!cancelled) setInitial(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loadError) {
    return (
      <main className="page">
        <p className="error-text">加载失败：{loadError}</p>
        <Link to="/">返回首页</Link>
      </main>
    );
  }
  if (!initial) {
    return (
      <main className="page">
        <p>加载中…</p>
      </main>
    );
  }
  return <BookLifecycle key={id} initial={initial} />;
}

/** 步骤推进按真实管线状态映射 */
function stepsForState(status: BookStatus): StepDef[] {
  const failed = status.state.startsWith('failed_');
  const stage = failed ? status.state.slice('failed_'.length) : status.state;
  const storyPhase = ['created', 'story_generating', 'story_moderating'].includes(stage);
  const artPhase = ['voice_review', 'pages_generating', 'enhance_generating'].includes(stage);
  const previewPhase = ['ready', 'exporting', 'completed'].includes(stage);
  return [
    { label: '故事创作', status: storyPhase ? 'current' : 'done' },
    { label: '插画与配音', status: artPhase ? 'current' : previewPhase ? 'done' : 'todo' },
    { label: '绘本预览与导出', status: previewPhase ? 'current' : 'todo' },
  ];
}

function BookLifecycle({ initial }: { initial: BookStatus }): JSX.Element {
  const { status, connected, narrationStates, narrationVersions, clipVersions } = useBookStream(initial);
  const [resuming, setResuming] = useState(false);
  // ready / exporting / completed 都持有 preview 资产，统一渲染预览面板
  // （导出中按钮在面板内显示「导出中…」，完成后显示下载链接）
  const isReady =
    !!status.preview &&
    (status.state === 'ready' || status.state === 'exporting' || status.state === 'completed');
  const isFailed = status.state.startsWith('failed_');

  const onResume = useCallback(async () => {
    setResuming(true);
    try {
      await resumeBook(status.book_id);
    } finally {
      setResuming(false);
    }
  }, [status.book_id]);

  const topbar = <Topbar steps={stepsForState(status)} />;

  if (isReady && status.preview) {
    return (
      <>
        {topbar}
        <main className="page">
          <header className="book-header">
            <Link to="/">← 新的绘本</Link>
          </header>
          <PreviewPane
            status={status}
            narrationStates={narrationStates}
            narrationVersions={narrationVersions}
            clipVersions={clipVersions}
          />
        </main>
      </>
    );
  }
  if (isFailed) {
    return (
      <>
        {topbar}
        <main className="page">
          <div className="page-card progress-stage">
            <p className="status-line">{stateLabel(status.state)}</p>
            {status.error && <p className="error-text">{status.error}</p>}
            <p className="hint">已完成的部分不会重跑，点击按钮从失败阶段继续。</p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                void onResume();
              }}
              disabled={resuming}
            >
              {resuming ? '恢复中…' : '从失败阶段继续'}
            </button>
          </div>
        </main>
      </>
    );
  }
  if (status.state === 'voice_review') {
    return (
      <>
        {topbar}
        <main className="page">
          {status.voice_review ? (
            <CharacterReview
              bookId={status.book_id}
              title={status.voice_review.title}
              characters={status.voice_review.characters}
              narratorVoice={status.voice_review.narrator_voice}
              pages={status.voice_review.pages}
            />
          ) : (
            <div className="page-card progress-stage">
              <p className="status-line">{stateLabel(status.state)}</p>
              <p className="hint">角色列表加载中…</p>
            </div>
          )}
        </main>
      </>
    );
  }
  const { pages_done, pages_total } = status.progress;
  const pct = pages_total > 0 ? Math.round((pages_done / pages_total) * 100) : 0;
  return (
    <>
      {topbar}
      <main className="page">
        <div className="page-card progress-stage">
          <p className="status-line">{stateLabel(status.state)}</p>
          <div
            className="progress-bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="hint">
            {pages_total > 0
              ? `已完成 ${pages_done} / ${pages_total} 页`
              : '页数由 AI 按内容量决定中…'}
            {!connected && '（实时连接已断开，正在重连…）'}
          </p>
          <p className="hint">可以离开此页面，稍后凭绘本链接回来继续查看。</p>
        </div>
      </main>
    </>
  );
}
