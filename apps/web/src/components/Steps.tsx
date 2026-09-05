import type { ReactNode } from 'react';

export type StepStatus = 'todo' | 'current' | 'done';

export interface StepDef {
  label: string;
  status: StepStatus;
}

/**
 * 顶部步骤条（视觉参考设计稿的胶囊步骤）。
 * 步骤由页面按真实流程传入，点击行为可选（无 onClick 时不可点）。
 */
export function Steps({ steps }: { steps: StepDef[] }): JSX.Element {
  return (
    <nav className="steps" aria-label="创作流程">
      {steps.map((s, i) => (
        <span key={s.label} style={{ display: 'contents' }}>
          {i > 0 && <span className="step-arrow" aria-hidden>
            ›
          </span>}
          <span
            className={`step ${s.status}`}
            aria-current={s.status === 'current' ? 'step' : undefined}
          >
            <span className="step-num">{s.status === 'done' ? '✓' : i + 1}</span>
            {s.label}
          </span>
        </span>
      ))}
    </nav>
  );
}

/** 顶栏容器：左侧步骤条，右侧动作区（预览/导出按钮等）。 */
export function Topbar({
  steps,
  actions,
}: {
  steps: StepDef[];
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Steps steps={steps} />
        {actions && <div className="topbar-actions">{actions}</div>}
      </div>
    </header>
  );
}
