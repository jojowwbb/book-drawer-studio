import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmCharacters,
  generateSceneClip,
  getProject,
  regenerateScene,
  selectLocation,
  selectPortrait,
} from '../api/project-client';
import type { ProjectStatus } from '../api/project-types';
import { ProjectPage } from './ProjectPage';

vi.mock('../api/project-client', () => ({
  getProject: vi.fn(),
  selectPortrait: vi.fn(),
  regeneratePortrait: vi.fn(),
  selectLocation: vi.fn(),
  regenerateLocation: vi.fn(),
  confirmCharacters: vi.fn(),
  resumeProject: vi.fn(),
  exportProject: vi.fn(),
  regenerateScene: vi.fn(),
  generateSceneClip: vi.fn(),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const analyzing: ProjectStatus = {
  project_id: 'p1',
  state: 'script_analyzing',
  style: 'anime',
  format: 'landscape',
  lang: 'zh',
  progress: { units_done: 0, units_total: 0 },
  characters: [],
  scenes: [],
};

const awaiting: ProjectStatus = {
  ...analyzing,
  state: 'awaiting_character_confirmation',
  characters: [
    {
      id: 'c1',
      name: '林晚',
      appearance: '短发少女',
      personality: '倔强而温柔',
      versions: [
        { seed: 1, url: '/assets/projects/p1/characters/c1-1.png' },
        { seed: 2, url: '/assets/projects/p1/characters/c2-2.png' },
        { seed: 3, url: '/assets/projects/p1/characters/c3-3.png' },
      ],
    },
  ],
  locations: [
    {
      id: 'l1',
      name: '山坡',
      description: '青草山坡，远处有村庄。',
      versions: [
        { seed: 11, url: '/assets/projects/p1/locations/l1/v1.png' },
        { seed: 12, url: '/assets/projects/p1/locations/l1/v2.png' },
      ],
    },
    {
      id: 'l9',
      name: '废弃矿洞',
      description: '没有任何场次引用的地点。',
      versions: [{ seed: 21, url: '/assets/projects/p1/locations/l9/v1.png' }],
    },
  ],
  script: {
    title: '测试剧本',
    style_anchor: '日系动画插画',
    lang: 'zh',
    locations: [
      { id: 'l1', name: '山坡', description: '青草山坡，远处有村庄。' },
      { id: 'l9', name: '废弃矿洞', description: '没有任何场次引用的地点。' },
    ],
    episodes: [
      {
        id: 'e1',
        title: '第一集',
        scenes: [{ id: 's1', synopsis: '小牧童在山坡上放羊。', dialogues: [], location_id: 'l1', scene_prompt: '画面' }],
      },
    ],
  },
};

const storyboard: ProjectStatus = {
  ...analyzing,
  state: 'storyboard_review',
  scenes: [
    { scene_id: 's1', seed: 1 },
    { scene_id: 's2', seed: 2 },
    { scene_id: 's3', seed: 3, clip_url: '/assets/projects/p1/scenes/s3/clip.mp4' },
  ],
  script: {
    title: '测试剧本',
    style_anchor: '日系动画插画',
    lang: 'zh',
    episodes: [
      {
        id: 'e1',
        title: '第一集',
        scenes: [
          {
            id: 's1',
            title: '山坡放羊',
            synopsis: '小牧童在山坡上看着羊群。',
            dialogues: [{ speaker: '小牧童', line: '好无聊啊。' }],
            scene_prompt: '主体动作：小牧童趴在石头上。环境光影：午后阳光洒在草地上。',
            camera: '镜头缓慢向主体推近',
          },
          {
            id: 's2',
            title: '第一次谎言',
            synopsis: '小牧童大喊狼来了。',
            dialogues: [],
            narration: '他一时兴起大喊起来。',
            scene_prompt: '主体动作：小牧童站起身挥手。环境光影：远处村庄升起炊烟。',
          },
          {
            id: 's3',
            synopsis: '村民们赶来。',
            dialogues: [],
            scene_prompt: '主体动作：村民奔跑。环境光影：黄昏光线。',
          },
        ],
      },
    ],
  },
};

function renderProjectPage(): void {
  render(
    <MemoryRouter initialEntries={['/project/p1']}>
      <Routes>
        <Route path="/project/:id" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProjectPage', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(getProject).mockReset();
    vi.mocked(selectPortrait).mockReset();
    vi.mocked(confirmCharacters).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows the analyzing progress bar and live SSE updates', async () => {
    vi.mocked(getProject).mockResolvedValue(analyzing);
    renderProjectPage();
    await waitFor(() => expect(screen.getByText('剧本分析中')).toBeTruthy());
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit({ projectId: 'p1', type: 'progress', progress: { units_done: 2, units_total: 6 } });
    });
    expect(screen.getByText('已完成 2 / 6')).toBeTruthy();
  });

  it('renders character and location walls at the confirmation checkpoint', async () => {
    vi.mocked(getProject).mockResolvedValue(awaiting);
    renderProjectPage();
    expect(await screen.findByText('林晚')).toBeTruthy();
    expect(screen.getByText('山坡')).toBeTruthy();
    expect(screen.getByText('未引用')).toBeTruthy();
    expect(screen.getByText('还有角色或场景未选定')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '确认角色与场景，开始分镜' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('selects portrait and referenced location to enable confirm', async () => {
    vi.mocked(getProject).mockResolvedValue(awaiting);
    vi.mocked(selectPortrait).mockResolvedValue({
      ...awaiting,
      characters: [{ ...awaiting.characters[0]!, selected: 2 }],
    });
    vi.mocked(selectLocation).mockResolvedValue({
      ...awaiting,
      characters: [{ ...awaiting.characters[0]!, selected: 2 }],
      locations: [
        { ...awaiting.locations![0]!, selected: 11 },
        awaiting.locations![1]!,
      ],
    });
    renderProjectPage();
    fireEvent.click(await screen.findByRole('button', { name: '林晚 立绘 2' }));
    await waitFor(() => expect(selectPortrait).toHaveBeenCalledWith('p1', 'c1', 2));
    // 角色已选但被引用场景未选 → 仍禁用
    expect(
      screen.getByRole('button', { name: '确认角色与场景，开始分镜' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '山坡 场景图 11' }));
    await waitFor(() => expect(selectLocation).toHaveBeenCalledWith('p1', 'l1', 11));
    expect(
      screen.getByRole('button', { name: '确认角色与场景，开始分镜' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('confirms characters and moves to the storyboard workbench', async () => {
    vi.mocked(getProject)
      .mockResolvedValueOnce({
        ...awaiting,
        characters: [{ ...awaiting.characters[0]!, selected: 1 }],
        locations: [{ ...awaiting.locations![0]!, selected: 11 }, awaiting.locations![1]!],
      })
      .mockResolvedValue(storyboard);
    vi.mocked(confirmCharacters).mockResolvedValue({ ...analyzing, state: 'storyboard_review' });
    renderProjectPage();
    const confirmBtn = await screen.findByRole('button', { name: '确认角色与场景，开始分镜' });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(confirmCharacters).toHaveBeenCalledWith('p1'));
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit({ projectId: 'p1', type: 'state', state: 'storyboard_review' });
    });
    expect(await screen.findByText('分镜工作台')).toBeTruthy();
  });

  it('per-scene single button: generate video, then redraw', async () => {
    vi.mocked(getProject).mockResolvedValue(storyboard);
    vi.mocked(generateSceneClip).mockResolvedValue({});
    vi.mocked(regenerateScene).mockResolvedValue({});
    renderProjectPage();
    expect(await screen.findByText('分镜工作台')).toBeTruthy();
    // s1/s2 无片段 → 生成视频；s3 已出片 → 重画
    fireEvent.click(screen.getAllByRole('button', { name: '生成视频' })[0]!);
    await waitFor(() => expect(generateSceneClip).toHaveBeenCalledWith('p1', 's1'));
    fireEvent.click(screen.getByRole('button', { name: '重画这一场' }));
    await waitFor(() => expect(regenerateScene).toHaveBeenCalledWith('p1', 's3'));
  });

  it('renders each scene script content in the workbench card', async () => {
    vi.mocked(getProject).mockResolvedValue(storyboard);
    renderProjectPage();
    expect(await screen.findByText('分镜工作台')).toBeTruthy();
    // s1：标题、剧情、对白、画面、运镜（不展示预设时长）
    expect(screen.getByText('山坡放羊')).toBeTruthy();
    expect(screen.getByText('小牧童在山坡上看着羊群。')).toBeTruthy();
    expect(screen.getByText('好无聊啊。')).toBeTruthy();
    expect(screen.getByText('小牧童')).toBeTruthy();
    expect(screen.getByText(/主体动作：小牧童趴在石头上/)).toBeTruthy();
    expect(screen.getByText('镜头缓慢向主体推近')).toBeTruthy();
    // s2：旁白场展示 narration
    expect(screen.getByText('他一时兴起大喊起来。')).toBeTruthy();
    // s3 未出片 → 脚本默认展开；已出片则折叠（此处三场均无 clip 的 s1/s2 展开）
    expect(screen.getAllByText('分镜脚本').length).toBe(3);
  });

  it('offers resume on failed states', async () => {
    vi.mocked(getProject).mockResolvedValue({ ...analyzing, state: 'failed_portraits_generating', error: 'boom' });
    renderProjectPage();
    expect(await screen.findByRole('button', { name: '从失败阶段继续' })).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
  });
});
