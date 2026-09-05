export interface BookProgressMsg {
  pages_done: number;
  pages_total: number;
}

export type PageClipStatus = 'generating' | 'ready' | 'failed';

export type HubMessage =
  | { bookId: string; type: 'state'; state: string }
  | { bookId: string; type: 'progress'; progress: BookProgressMsg }
  | { bookId: string; type: 'completed' }
  | { bookId: string; type: 'failed'; error: string }
  | {
      bookId: string;
      type: 'page_image';
      page_id: string;
      status: PageClipStatus;
      error?: string;
    }
  | {
      bookId: string;
      type: 'page_clip';
      page_id: string;
      status: PageClipStatus;
      error?: string;
    }
  | {
      bookId: string;
      type: 'page_narration';
      page_id: string;
      status: PageClipStatus;
      error?: string;
    };

/** 故事视频产线（projects）的 SSE 消息 */
export type ProjectUnitStatus = 'generating' | 'ready' | 'failed';

export interface ProjectProgressMsg {
  units_done: number;
  units_total: number;
}

export type ProjectHubMessage =
  | { projectId: string; type: 'state'; state: string }
  | { projectId: string; type: 'progress'; progress: ProjectProgressMsg }
  | { projectId: string; type: 'completed' }
  | { projectId: string; type: 'failed'; error: string }
  | { projectId: string; type: 'portrait'; char_id: string; status: ProjectUnitStatus; error?: string }
  | { projectId: string; type: 'location'; loc_id: string; status: ProjectUnitStatus; error?: string }
  | { projectId: string; type: 'scene_clip'; scene_id: string; status: ProjectUnitStatus; error?: string }
  | { projectId: string; type: 'scene_narration'; scene_id: string; status: ProjectUnitStatus; error?: string };

/** 按订阅 key（bookId/projectId）分发的泛型事件总线 */
export class EventHub<M = HubMessage> {
  private subscribers = new Map<string, Set<(msg: M) => void>>();

  subscribe(key: string, cb: (msg: M) => void): () => void {
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    const target = set;
    target.add(cb);
    return () => {
      target.delete(cb);
    };
  }

  publish(key: string, msg: M): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    for (const cb of [...set]) cb(msg);
  }
}
