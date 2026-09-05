import { useEffect, useRef, useState } from 'react';
import {
  confirmVoices,
  getBookCharacters,
  setBookCharacterVoices,
  voiceDemoUrl,
} from '../api/client';
import type { ReviewCharacter } from '../api/types';

/** 旁白条目的特殊 key（与服务端 NARRATOR 常量一致） */
const NARRATOR_KEY = '旁白';

/**
 * 音色确认面板：故事定稿后产线停在 voice_review，在这里核对 AI 预配的旁白与角色音色、
 * 逐个试听（预生成静态 demo），改配后确认，推进到插画与配音阶段。
 */
export function CharacterReview({
  bookId,
  characters,
  narratorVoice,
}: {
  bookId: string;
  characters: ReviewCharacter[];
  narratorVoice: string | null;
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
