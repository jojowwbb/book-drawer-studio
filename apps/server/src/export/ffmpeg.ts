import { spawn } from 'node:child_process';

/** ffprobe 读取媒体时长（毫秒）。 */
export function probeDurationMs(path: string, bin = 'ffprobe'): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${stderr.slice(-500)}`));
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return reject(new Error(`ffprobe bad duration: ${stdout.trim()}`));
      }
      resolve(Math.round(seconds * 1000));
    });
  });
}

/** ffprobe 判断媒体是否含音频流。 */
export function probeHasAudio(path: string, bin = 'ffprobe'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${stderr.slice(-500)}`));
      resolve(stdout.trim().length > 0);
    });
  });
}

export function spawnFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-4000)}`)),
    );
  });
}

/** 逐帧写 PNG 字节流到 ffmpeg stdin，处理背压。 */
export function pipeFrames(
  bin: string,
  args: string[],
  nextFrame: (index: number) => Promise<Uint8Array>,
  count: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-4000)}`)),
    );

    let failed = false;
    const writeAll = async (): Promise<void> => {
      for (let i = 0; i < count && !failed; i++) {
        const bytes = await nextFrame(i);
        const ok = child.stdin.write(Buffer.from(bytes));
        if (!ok) await new Promise<void>((r) => child.stdin.once('drain', r));
      }
      if (!failed) child.stdin.end();
    };
    void writeAll().catch((err) => {
      failed = true;
      child.kill('SIGKILL');
      reject(err);
    });
  });
}

const PNG_PREFIX = 'data:image/png;base64,';

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  return Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64');
}
