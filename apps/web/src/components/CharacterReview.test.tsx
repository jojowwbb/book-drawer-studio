import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmVoices, getBookCharacters, setBookCharacterVoices } from '../api/client';

vi.mock('../api/client', () => ({
  getBookCharacters: vi.fn(),
  setBookCharacterVoices: vi.fn(),
  confirmVoices: vi.fn(),
  voiceDemoUrl: (v: string) => `/voice-demos/${v.toLowerCase()}.wav`,
}));

import { CharacterReview } from './CharacterReview';

const characters = [
  { name: '小兔子', appearance_desc: '白色绒毛', voice: 'Bella' },
  { name: '兔妈妈', appearance_desc: '围裙', voice: null },
];

beforeEach(() => {
  vi.mocked(getBookCharacters).mockReset().mockResolvedValue({
    characters,
    narrator_voice: null,
    voices: { Bella: '萌宝女童声', Elias: '讲解女声', Cherry: '亲切女声' },
  });
  vi.mocked(setBookCharacterVoices).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(confirmVoices).mockReset().mockResolvedValue({ state: 'pages_generating' });
});

afterEach(() => cleanup());

describe('CharacterReview', () => {
  it('renders a narrator row ahead of the characters', async () => {
    render(<CharacterReview bookId="b1" characters={characters} narratorVoice={null} />);
    expect(await screen.findByLabelText('旁白的配音音色')).toBeTruthy();
    expect(screen.getByLabelText('小兔子 的配音音色')).toBeTruthy();
    expect(screen.getByLabelText('兔妈妈 的配音音色')).toBeTruthy();
    // 选项来自音色板 + 默认项
    const narrator = screen.getByLabelText('旁白的配音音色') as HTMLSelectElement;
    expect(navigatorOptions(narrator)).toEqual(['', 'Bella', 'Elias', 'Cherry']);
  });

  it('saves narrator voice under the 旁白 key on confirm', async () => {
    render(<CharacterReview bookId="b1" characters={characters} narratorVoice={null} />);
    const narrator = await screen.findByLabelText('旁白的配音音色');
    fireEvent.change(narrator, { target: { value: 'Elias' } });
    fireEvent.click(screen.getByRole('button', { name: '确认音色，开始插画与配音' }));
    await waitFor(() =>
      expect(setBookCharacterVoices).toHaveBeenCalledWith('b1', {
        旁白: 'Elias',
        小兔子: 'Bella',
        兔妈妈: null,
      }),
    );
    expect(confirmVoices).toHaveBeenCalledWith('b1');
  });

  it('prefills the narrator select from narratorVoice prop', async () => {
    render(<CharacterReview bookId="b1" characters={characters} narratorVoice="Cherry" />);
    const narrator = (await screen.findByLabelText('旁白的配音音色')) as HTMLSelectElement;
    expect(narrator.value).toBe('Cherry');
    // 已选音色（旁白 Cherry + 小兔子 Bella）各自出现试听按钮
    expect(screen.getAllByRole('button', { name: '试听' })).toHaveLength(2);
  });
});

function navigatorOptions(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((o) => o.value);
}
