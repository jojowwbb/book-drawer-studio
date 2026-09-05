import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  confirmCharacters,
  exportProject,
  generateSceneClip,
  getProject,
  regenerateLocation,
  regeneratePortrait,
  regenerateScene,
  resumeProject,
  selectLocation,
  selectPortrait,
} from '../api/project-client';
import type {
  CharacterCard,
  LocationCard,
  ProjectStatus,
  ScriptLocationContent,
  ScriptSceneContent,
} from '../api/project-types';
import { Topbar, type StepDef } from '../components/Steps';
import { useProjectStream } from '../hooks/useProjectStream';
import { stateLabel } from '../lib/labels';

export function ProjectPage(): JSX.Element | null {
  const { id = '' } = useParams();
  const [initial, setInitial] = useState<ProjectStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInitial(null);
    setLoadError(null);
    getProject(id)
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
        <Link to="/project/create">返回新建</Link>
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
  return <ProjectLifecycle key={id} initial={initial} />;
}

function stepsForState(status: ProjectStatus): StepDef[] {
  const failed = status.state.startsWith('failed_');
  const stage = failed ? status.state.slice('failed_'.length) : status.state;
  const scriptPhase = ['created', 'script_analyzing', 'script_moderating'].includes(stage);
  const charPhase = ['portraits_generating', 'awaiting_character_confirmation'].includes(stage);
  const boardPhase = ['storyboard_review', 'ready', 'exporting', 'completed'].includes(stage);
  return [
    { label: '剧本分析', status: scriptPhase ? 'current' : 'done' },
    { label: '角色与场景定制', status: charPhase ? 'current' : boardPhase ? 'done' : 'todo' },
    { label: '分镜与成片', status: boardPhase ? 'current' : 'todo' },
  ];
}

function ProjectLifecycle({ initial }: { initial: ProjectStatus }): JSX.Element {
  const { status, connected, portraitStates, locationStates, clipStates } = useProjectStream(initial);
  const [resuming, setResuming] = useState(false);
  const isFailed = status.state.startsWith('failed_');
  const topbar = <Topbar steps={stepsForState(status)} />;

  const onResume = useCallback(async () => {
    setResuming(true);
    try {
      await resumeProject(status.project_id);
    } finally {
      setResuming(false);
    }
  }, [status.project_id]);

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
              onClick={() => void onResume()}
              disabled={resuming}
            >
              {resuming ? '恢复中…' : '从失败阶段继续'}
            </button>
          </div>
        </main>
      </>
    );
  }

  if (status.state === 'awaiting_character_confirmation') {
    return (
      <>
        {topbar}
        <main className="page">
          <CharacterWall
            status={status}
            portraitStates={portraitStates}
            locationStates={locationStates}
            projectId={status.project_id}
          />
        </main>
      </>
    );
  }

  const boardPhase = ['storyboard_review', 'ready', 'exporting', 'completed'].includes(
    status.state,
  );
  if (boardPhase) {
    return (
      <>
        {topbar}
        <main
          className="page"
          style={{ ['--pb-ar' as string]: status.format === 'portrait' ? '0.5625' : '1.7778' }}
        >
          <Storyboard status={status} clipStates={clipStates} />
        </main>
      </>
    );
  }

  // 剧本分析 / 立绘生成中：进度条
  const { units_done, units_total } = status.progress;
  const pct = units_total > 0 ? Math.round((units_done / units_total) * 100) : 0;
  return (
    <>
      {topbar}
      <main className="page">
        <div className="page-card progress-stage">
          <p className="status-line">{stateLabel(status.state)}</p>
          <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="hint">
            {units_total > 0 ? `已完成 ${units_done} / ${units_total}` : 'AI 正在分析剧本结构…'}
            {!connected && '（实时连接已断开，正在重连…）'}
          </p>
          <p className="hint">可以离开此页面，稍后凭项目链接回来继续查看。</p>
        </div>
      </main>
    </>
  );
}

/** 被任一场引用的地点 id（confirm 只强制要求这些地点选定） */
function referencedLocationIds(status: ProjectStatus): Set<string> {
  const ids = new Set<string>();
  for (const ep of status.script?.episodes ?? []) {
    for (const sc of ep.scenes) if (sc.location_id) ids.add(sc.location_id);
  }
  return ids;
}

function CharacterWall({
  status,
  portraitStates,
  locationStates,
  projectId,
}: {
  status: ProjectStatus;
  portraitStates: Record<string, { phase: 'generating' | 'failed'; error?: string }>;
  locationStates: Record<string, { phase: 'generating' | 'failed'; error?: string }>;
  projectId: string;
}): JSX.Element {
  const [local, setLocal] = useState<CharacterCard[]>(status.characters);
  const [locs, setLocs] = useState<LocationCard[]>(status.locations ?? []);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Record<string, { appearance: string; costume: string }>>({});
  const [locEditing, setLocEditing] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setLocal(status.characters), [status.characters]);
  useEffect(() => setLocs(status.locations ?? []), [status.locations]);

  const onSelect = async (card: CharacterCard, seed: number): Promise<void> => {
    setError(null);
    try {
      const updated = await selectPortrait(projectId, card.id, seed);
      setLocal(updated.characters);
    } catch (e) {
      setError(e instanceof Error ? e.message : '选择失败');
    }
  };

  const onRegen = async (card: CharacterCard): Promise<void> => {
    setError(null);
    setBusy((b) => ({ ...b, [card.id]: true }));
    const draft = editing[card.id];
    try {
      const res = await regeneratePortrait(projectId, card.id, {
        appearance: draft?.appearance?.trim() || undefined,
        costume: draft?.costume?.trim() || undefined,
      });
      setLocal(res.characters);
      setEditing((m) => ({ ...m, [card.id]: { appearance: '', costume: '' } }));
    } catch (e) {
      setError(describeErr(e));
    } finally {
      setBusy((b) => ({ ...b, [card.id]: false }));
    }
  };

  const onLocSelect = async (card: LocationCard, seed: number): Promise<void> => {
    setError(null);
    try {
      const updated = await selectLocation(projectId, card.id, seed);
      setLocs(updated.locations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '选择失败');
    }
  };

  const onLocRegen = async (card: LocationCard): Promise<void> => {
    setError(null);
    setBusy((b) => ({ ...b, [card.id]: true }));
    try {
      const res = await regenerateLocation(
        projectId,
        card.id,
        locEditing[card.id]?.trim() || undefined,
      );
      setLocs(res.locations);
      setLocEditing((m) => ({ ...m, [card.id]: '' }));
    } catch (e) {
      setError(describeErr(e));
    } finally {
      setBusy((b) => ({ ...b, [card.id]: false }));
    }
  };

  const onConfirm = async (): Promise<void> => {
    setError(null);
    setConfirming(true);
    try {
      await confirmCharacters(projectId);
    } catch (e) {
      setError(describeErr(e));
      setConfirming(false);
    }
  };

  const referenced = referencedLocationIds(status);
  const allSelected =
    local.length > 0 &&
    local.every((c) => c.selected !== undefined) &&
    locs.every((l) => !referenced.has(l.id) || l.selected !== undefined);

  return (
    <div className="page-card">
      <header className="panel-head">
        <h2 className="panel-title">角色定制</h2>
        <span className="panel-sub">为每个角色挑选一版立绘；不满意可改描述重出（每角色最多 3 轮）。立绘与场景图将作为 r2v 参考图锁定一致性</span>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="char-wall">
        {local.map((card) => {
          const state = portraitStates[card.id];
          const draft = editing[card.id] ?? { appearance: card.appearance, costume: card.costume ?? '' };
          return (
            <section key={card.id} className={`char-card ${card.selected !== undefined ? 'picked' : ''}`}>
              <div className="char-head">
                <strong>{card.name}</strong>
                {card.selected !== undefined && <em className="char-picked">已选定</em>}
              </div>
              <p className="char-meta">{card.personality}</p>
              <div className="portrait-row">
                {card.versions.map((v) => (
                  <button
                    key={v.seed}
                    type="button"
                    className={card.selected === v.seed ? 'portrait active' : 'portrait'}
                    disabled={!v.url}
                    onClick={() => void onSelect(card, v.seed)}
                    title={v.failed ? v.error : '选这一版'}
                  >
                    {v.url ? <img src={v.url} alt={`${card.name} 立绘 ${v.seed}`} /> : <span className="portrait-fail">失败</span>}
                  </button>
                ))}
                {state?.phase === 'generating' && <span className="portrait placeholder">生成中…</span>}
              </div>
              <div className="char-edit">
                <input
                  type="text"
                  value={draft.appearance}
                  onChange={(e) => setEditing((m) => ({ ...m, [card.id]: { ...draft, appearance: e.target.value } }))}
                  placeholder="外形描述"
                  aria-label={`${card.name} 外形`}
                />
                <input
                  type="text"
                  value={draft.costume}
                  onChange={(e) => setEditing((m) => ({ ...m, [card.id]: { ...draft, costume: e.target.value } }))}
                  placeholder="服装（可选）"
                  aria-label={`${card.name} 服装`}
                />
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  disabled={busy[card.id]}
                  onClick={() => void onRegen(card)}
                >
                  {busy[card.id] ? '重出中…' : state?.phase === 'generating' ? '生成中…' : '改描述重出'}
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {locs.length > 0 && (
        <>
          <header className="panel-head" style={{ marginTop: 24 }}>
            <h2 className="panel-title">场景定制</h2>
            <span className="panel-sub">为每个地点挑选一版场景图（空镜全景）；被分镜引用的地点必须选定</span>
          </header>
          <div className="char-wall">
            {locs.map((card) => {
              const state = locationStates[card.id];
              const draft = locEditing[card.id] ?? card.description;
              const isReferenced = referenced.has(card.id);
              return (
                <section key={card.id} className={`char-card ${card.selected !== undefined ? 'picked' : ''}`}>
                  <div className="char-head">
                    <strong>{card.name}</strong>
                    {card.selected !== undefined ? (
                      <em className="char-picked">已选定</em>
                    ) : !isReferenced ? (
                      <em className="loc-unreferenced">未引用</em>
                    ) : null}
                  </div>
                  <p className="char-meta">{card.description}</p>
                  <div className="portrait-row">
                    {card.versions.map((v) => (
                      <button
                        key={v.seed}
                        type="button"
                        className={card.selected === v.seed ? 'portrait scene-thumb active' : 'portrait scene-thumb'}
                        disabled={!v.url}
                        onClick={() => void onLocSelect(card, v.seed)}
                        title={v.failed ? v.error : '选这一版'}
                      >
                        {v.url ? <img src={v.url} alt={`${card.name} 场景图 ${v.seed}`} /> : <span className="portrait-fail">失败</span>}
                      </button>
                    ))}
                    {state?.phase === 'generating' && <span className="portrait scene-thumb placeholder">生成中…</span>}
                  </div>
                  <div className="char-edit">
                    <input
                      type="text"
                      value={draft}
                      onChange={(e) => setLocEditing((m) => ({ ...m, [card.id]: e.target.value }))}
                      placeholder="场景描述"
                      aria-label={`${card.name} 场景描述`}
                    />
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      disabled={busy[card.id]}
                      onClick={() => void onLocRegen(card)}
                    >
                      {busy[card.id] ? '重出中…' : state?.phase === 'generating' ? '生成中…' : '改描述重出'}
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
      <div className="char-confirm">
        <button type="button" className="btn-primary" disabled={!allSelected || confirming} onClick={() => void onConfirm()}>
          {confirming ? '进入分镜中…' : '确认角色与场景，开始分镜'}
        </button>
        {!allSelected && <span className="hint">还有角色或场景未选定</span>}
      </div>
    </div>
  );
}

function Storyboard({
  status,
  clipStates,
}: {
  status: ProjectStatus;
  clipStates: Record<string, { phase: 'generating' | 'failed'; error?: string }>;
}): JSX.Element {
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const stage = status.state;
  const actionable = stage === 'storyboard_review' || stage === 'ready' || stage === 'completed';

  const runScene = async (sceneId: string, fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setBusy((b) => ({ ...b, [sceneId]: true }));
    try {
      await fn();
    } catch (e) {
      setError(describeErr(e));
    } finally {
      setBusy((b) => ({ ...b, [sceneId]: false }));
    }
  };

  const onExport = async (): Promise<void> => {
    setError(null);
    setExporting(true);
    try {
      await exportProject(status.project_id);
    } catch (e) {
      setError(describeErr(e));
      setExporting(false);
    }
  };

  const clipsDone = status.scenes.filter((m) => m.clip_url).length;
  const total = status.scenes.length;
  const allReady = total > 0 && clipsDone === total;

  // 剧本原文按场次 id 建索引，卡片展示脚本内容
  const scriptById = new Map<string, ScriptSceneContent>();
  const locationById = new Map<string, ScriptLocationContent>();
  for (const loc of status.script?.locations ?? []) {
    locationById.set(loc.id, loc);
  }
  for (const ep of status.script?.episodes ?? []) {
    for (const sc of ep.scenes) scriptById.set(sc.id, sc);
  }

  return (
    <div className="page-card">
      <header className="panel-head">
        <h2 className="panel-title">分镜工作台</h2>
        <span className="panel-sub">
          逐个镜头点击生成，确认无误再继续；全部出片后可导出成片（已出片 {clipsDone}/{total}）
        </span>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="scene-grid">
        {status.scenes.map((m) => {
          const clip = clipStates[m.scene_id];
          const busyScene = busy[m.scene_id] || clip?.phase === 'generating';
          const hasClip = !!m.clip_url;
          const sc = scriptById.get(m.scene_id);
          return (
            <section key={m.scene_id} className="scene-card">
              <div className="scene-media">
                {m.clip_url ? (
                  <video src={m.clip_url} controls preload="metadata" />
                ) : (
                  <span className="scene-pending">{busyScene ? '生成中…' : '待生成'}</span>
                )}
                {m.clip_failed && <span className="thumb-badge fail">片</span>}
              </div>
              <div className="scene-foot">
                <span className="scene-id">{m.scene_id}</span>
                {sc?.title && <span className="scene-title">{sc.title}</span>}
                {actionable && (
                  <div className="scene-actions">
                    {!hasClip ? (
                      <button
                        type="button"
                        className="btn-primary btn-small"
                        disabled={busyScene}
                        onClick={() => void runScene(m.scene_id, () => generateSceneClip(status.project_id, m.scene_id))}
                      >
                        {busyScene ? '生成中…' : m.clip_failed ? '重试视频' : '生成视频'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost btn-small"
                        disabled={busyScene}
                        onClick={() => void runScene(m.scene_id, () => regenerateScene(status.project_id, m.scene_id))}
                        title="换 seed 重跑该场 r2v（保留配音）"
                      >
                        {busyScene ? '重画中…' : '重画这一场'}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {sc && (
                <details className="scene-script" open={!hasClip}>
                  <summary>分镜脚本</summary>
                  <dl>
                    <dt>剧情</dt>
                    <dd>{sc.synopsis}</dd>
                    {sc.narration && (
                      <>
                        <dt>旁白</dt>
                        <dd className="script-narration">{sc.narration}</dd>
                      </>
                    )}
                    {sc.dialogues.length > 0 && (
                      <>
                        <dt>对白</dt>
                        <dd>
                          <ul className="script-lines">
                            {sc.dialogues.map((d, i) => (
                              <li key={i}>
                                <b>{d.speaker}</b>
                                <span>{d.line}</span>
                              </li>
                            ))}
                          </ul>
                        </dd>
                      </>
                    )}
                    <dt>画面</dt>
                    <dd>{sc.scene_prompt}</dd>
                    {sc.location_id &&
                      (() => {
                        const loc = locationById.get(sc.location_id);
                        return loc ? (
                          <>
                            <dt>场景</dt>
                            <dd className="script-location">
                              <b>{loc.name}</b>
                              <span>{loc.description}</span>
                            </dd>
                          </>
                        ) : null;
                      })()}
                    {sc.camera && (
                      <>
                        <dt>运镜</dt>
                        <dd>{sc.camera}</dd>
                      </>
                    )}
                  </dl>
                </details>
              )}
              {clip?.phase === 'failed' && (
                <p className="error-text" role="alert">视频失败：{clip.error ?? '未知错误'}</p>
              )}
            </section>
          );
        })}
      </div>
      <div className="char-confirm">
        {status.export ? (
          <>
            <a className="btn-primary" href={status.export.url} download>
              下载成片
            </a>
            <span className="hint">
              时长 {(status.export.duration_ms / 1000).toFixed(1)}s · {(status.export.size_bytes / 1024 / 1024).toFixed(1)}MB
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn-primary"
              disabled={!allReady || stage !== 'ready' || exporting}
              onClick={() => void onExport()}
            >
              {stage === 'exporting' || exporting ? '导出中…' : '导出成片'}
            </button>
            {!allReady && <span className="hint">还有 {total - clipsDone} 个镜头未出片</span>}
          </>
        )}
      </div>
    </div>
  );
}

function describeErr(e: unknown): string {
  if (e && typeof e === 'object' && 'payload' in e) {
    const p = (e as { payload?: { error?: string } }).payload;
    if (p?.error) return p.error;
  }
  return e instanceof Error ? e.message : '操作失败';
}
