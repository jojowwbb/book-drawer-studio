import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  confirmVoices,
  editPageText,
  getBookCharacters,
  setBookCharacterVoices,
  voiceDemoUrl,
} from '../api/client';
import type { ReviewCharacter, ReviewScriptPage } from '../api/types';

/** 旁白条目的特殊 key（与服务端 NARRATOR 常量一致） */
const NARRATOR_KEY = '旁白';

/** 分段转回【说话人】标记文本，作为编辑框的初始内容 */
const toMarkup = (p: ReviewScriptPage): string =>
  p.segments && p.segments.length > 0
    ? p.segments.map((s) => `【${s.speaker}】${s.text}`).join('')
    : p.narration;

/** 展示用：按【说话人】标记拆成分段（与服务端 parseSpeakerMarkup 同规则）；标记前文本算旁白 */
function splitMarkup(text: string): { speaker: string | null; body: string }[] {
  const re = /[【\[]([^\]】]+)[】\]]/g;
  const parts: { speaker: string | null; body: string }[] = [];
  let last = 0;
  let speaker: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ speaker, body: text.slice(last, m.index) });
    speaker = m[1]!.trim();
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ speaker, body: text.slice(last) });
  return parts.filter((p) => p.body.trim());
}

/**
 * 音色确认面板：故事定稿后产线停在 voice_review，在这里核对 AI 预配的旁白与角色音色、
 * 逐个试听（预生成静态 demo），改配后确认，推进到插画与配音阶段。
 * 同时展示剧本页台词（含分角色分段），可对照台词调音色，也可直接修改台词。
 */
export function CharacterReview({
  bookId,
  title,
  characters,
  narratorVoice,
  pages,
}: {
  bookId: string;
  title?: string;
  characters: ReviewCharacter[];
  narratorVoice: string | null;
  pages?: ReviewScriptPage[];
}): JSX.Element {
  const [palette, setPalette] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<Record<string, string | null>>(() => ({
    [NARRATOR_KEY]: narratorVoice,
    ...Object.fromEntries(characters.map((c) => [c.name, c.voice])),
  }));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 剧本页台词（【说话人】标记文本），本地草稿优先于轮询回来的 props
  const [script, setScript] = useState<Record<string, string>>(() =>
    Object.fromEntries((pages ?? []).map((p) => [p.page_id, toMarkup(p)])),
  );
  const [editingPage, setEditingPage] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getBookCharacters(bookId)
      .then((res) => {
        if (!cancelled) setPalette(res.voices);
      })
      .catch(() => {
        // 音色板拉取失败不阻塞：试听与下拉退化为空
      });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const audition = (voice: string): void => {
    audioRef.current?.pause();
    const audio = new Audio(voiceDemoUrl(voice));
    audioRef.current = audio;
    audio.onplay = () => setPlaying(voice);
    audio.onended = () => setPlaying((p) => (p === voice ? null : p));
    audio.onerror = () => {
      setPlaying(null);
      setError(`「${voice}」试听文件缺失`);
    };
    void audio.play().catch(() => setError('浏览器阻止了自动播放，请再点一次试听'));
  };

  const stopAudition = (): void => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };

  const startEdit = (p: ReviewScriptPage): void => {
    setError(null);
    setDraft(script[p.page_id] ?? toMarkup(p));
    setEditingPage(p.page_id);
  };

  const saveScript = async (pageId: string): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await editPageText(bookId, pageId, { narration: draft });
      setScript((m) => ({ ...m, [pageId]: draft }));
      setEditingPage(null);
    } catch (err) {
      if (err instanceof ApiError) {
        const payload = err.payload as { error?: string; speakers?: string[]; reason?: string } | null;
        if (payload?.error === 'unknown_speakers') {
          setError(
            `找不到这些角色：${(payload.speakers ?? []).join('、')}。请检查【】里的名字是否和角色一致（旁白请用【旁白】）`,
          );
        } else if (payload?.error === 'input_rejected') {
          setError(`内容未通过安全校验：${payload.reason ?? '请修改后再试'}`);
        } else {
          setError('保存失败，请重试');
        }
      } else {
        setError('保存失败，请重试');
      }
    } finally {
      setSaving(false);
    }
  };

  const onConfirm = async (): Promise<void> => {
    setConfirming(true);
    setError(null);
    try {
      await setBookCharacterVoices(bookId, voices);
      await confirmVoices(bookId);
    } catch (err) {
      setError(err instanceof Error ? `确认失败：${err.message}` : '确认失败，请重试');
      setConfirming(false);
    }
  };

  return (
    <div className="page-card voice-review">
      <h2>确认角色音色</h2>
      <p className="hint">
        故事已定稿。AI 已为旁白和每个角色预配了配音音色，可试听并调整；确认后才开始生成插画与配音。
      </p>
      {pages && pages.length > 0 && (
        <section className="script-review">
          <h3>剧本对照{title ? `：《${title}》` : ''}</h3>
          <p className="hint">
            逐页核对台词与说话人，点「修改台词」可直接改文本（用【旁白】【角色名】标记谁念哪句）。
          </p>
          <ul className="script-list">
            {pages.map((p, i) => (
              <li key={p.page_id} className="script-page">
                <div className="script-page-head">
                  <strong>第 {i + 1} 页</strong>
                  <span className="hint">{p.page_text}</span>
                </div>
                {editingPage === p.page_id ? (
                  <div className="script-edit">
                    <textarea
                      aria-label={`第 ${i + 1} 页台词`}
                      value={draft}
                      rows={4}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <div className="script-edit-ctrl">
                      <button
                        type="button"
                        className="btn-primary btn-small"
                        disabled={saving || !draft.trim()}
                        onClick={() => void saveScript(p.page_id)}
                      >
                        {saving ? '保存中…' : '保存'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        disabled={saving}
                        onClick={() => setEditingPage(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="script-lines">
                      {splitMarkup(script[p.page_id] ?? toMarkup(p)).map((seg, j) => (
                        <p key={j} className="script-line">
                          {seg.speaker && (
                            <span
                              className={`script-speaker${
                                seg.speaker === NARRATOR_KEY ? ' is-narrator' : ''
                              }`}
                            >
                              【{seg.speaker}】
                            </span>
                          )}
                          {seg.body}
                        </p>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => startEdit(p)}
                    >
                      修改台词
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="voice-list">
        <li className="voice-item">
          <div className="voice-item-head">
            <strong>{NARRATOR_KEY}</strong>
            <span className="hint">故事讲述人（片头标题配音也用这个音色）</span>
          </div>
          <div className="voice-item-ctrl">
            <select
              aria-label="旁白的配音音色"
              value={voices[NARRATOR_KEY] ?? ''}
              onChange={(e) => setVoices((m) => ({ ...m, [NARRATOR_KEY]: e.target.value || null }))}
            >
              <option value="">默认旁白音色</option>
              {Object.entries(palette).map(([id, desc]) => (
                <option key={id} value={id}>
                  {id} — {desc}
                </option>
              ))}
            </select>
            {voices[NARRATOR_KEY] && (
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={() =>
                  playing === voices[NARRATOR_KEY] ? stopAudition() : audition(voices[NARRATOR_KEY]!)
                }
              >
                {playing === voices[NARRATOR_KEY] ? '停止试听' : '试听'}
              </button>
            )}
          </div>
        </li>
        {characters.map((c) => {
          const voice = voices[c.name] ?? null;
          return (
            <li key={c.name} className="voice-item">
              <div className="voice-item-head">
                <strong>{c.name}</strong>
                <span className="hint">{c.appearance_desc}</span>
              </div>
              <div className="voice-item-ctrl">
                <select
                  aria-label={`${c.name} 的配音音色`}
                  value={voice ?? ''}
                  onChange={(e) =>
                    setVoices((m) => ({ ...m, [c.name]: e.target.value || null }))
                  }
                >
                  <option value="">默认旁白音色</option>
                  {Object.entries(palette).map(([id, desc]) => (
                    <option key={id} value={id}>
                      {id} — {desc}
                    </option>
                  ))}
                </select>
                {voice && (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => (playing === voice ? stopAudition() : audition(voice))}
                  >
                    {playing === voice ? '停止试听' : '试听'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="char-confirm">
        <button
          type="button"
          className="btn-primary"
          disabled={confirming}
          onClick={() => void onConfirm()}
        >
          {confirming ? '生成中…' : '确认音色，开始插画与配音'}
        </button>
      </div>
    </div>
  );
}
