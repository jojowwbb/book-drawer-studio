import { BookPlayer, type BookSpec } from '@pb/renderer';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { pageStartTimes } from '../lib/spec';

export interface BookPlayerHandle {
  seekPage(index: number): void;
  play(): void;
  pause(): void;
}

interface BookPlayerCanvasProps {
  spec: BookSpec;
  autoPlay?: boolean;
  onActivePageChange?: (pageIndex: number) => void;
}

export const BookPlayerCanvas = forwardRef<BookPlayerHandle, BookPlayerCanvasProps>(
  ({ spec, autoPlay = true, onActivePageChange }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const playerRef = useRef<BookPlayer | null>(null);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
      let cancelled = false;
      let settled = false;
      setReady(false);
      setFailed(false);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const player = new BookPlayer(canvas, spec);
      playerRef.current = player;
      const initPromise = player.init();
      initPromise
        .then(() => {
          settled = true;
          if (cancelled) {
            player.destroy();
            return;
          }
          setReady(true);
          if (autoPlay) player.play();
        })
        .catch(() => {
          settled = true;
          if (!cancelled) setFailed(true);
        });
      return () => {
        cancelled = true;
        // init 未稳定时不能立刻 destroy：异步的逐页纹理加载仍在向活动上下文
        // 上传，等 init 稳定后再销毁，避免与已销毁的 WebGL 上下文竞态
        if (settled) {
          player.destroy();
        } else {
          void initPromise.finally(() => player.destroy());
        }
        playerRef.current = null;
      };
    }, [spec, autoPlay]);

    useEffect(() => {
      if (!ready || !onActivePageChange) return;
      let raf = 0;
      let last = -1;
      const tick = (): void => {
        const player = playerRef.current;
        if (player) {
          const idx = player.pageIndexAt(player.currentTimeMs);
          if (idx !== last) {
            last = idx;
            onActivePageChange(idx);
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [ready, onActivePageChange]);

    useImperativeHandle(ref, () => ({
      seekPage(index: number) {
        const player = playerRef.current;
        if (!player) return;
        const starts = pageStartTimes(spec);
        const clamped = Math.min(Math.max(0, index), starts.length - 1);
        player.seek(starts[clamped] ?? 0);
        onActivePageChange?.(player.pageIndexAt(player.currentTimeMs));
      },
      play() {
        playerRef.current?.play();
      },
      pause() {
        playerRef.current?.pause();
      },
    }));

    return (
      <div className="player-shell">
        <canvas ref={canvasRef} className="player-canvas" aria-label="绘本预览画布" />
        {!ready && !failed && <div className="player-overlay">预览加载中…</div>}
        {failed && (
          <div className="player-overlay player-error">预览初始化失败，请刷新重试</div>
        )}
      </div>
    );
  },
);

BookPlayerCanvas.displayName = 'BookPlayerCanvas';
