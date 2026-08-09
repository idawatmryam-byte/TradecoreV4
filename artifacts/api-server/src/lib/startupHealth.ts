export type EngineResumeHealth = {
  status: "pending" | "healthy" | "degraded";
  expected: number;
  resumed: number;
  failed: number;
  startedAt: string | null;
  completedAt: string | null;
};

let state: EngineResumeHealth = {
  status: "pending",
  expected: 0,
  resumed: 0,
  failed: 0,
  startedAt: null,
  completedAt: null,
};

function finishIfComplete(): void {
  if (state.resumed + state.failed < state.expected) return;
  state = {
    ...state,
    status: state.failed === 0 ? "healthy" : "degraded",
    completedAt: new Date().toISOString(),
  };
}

export function beginEngineResume(expected: number): void {
  state = {
    status: "pending",
    expected,
    resumed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  finishIfComplete();
}

export function recordEngineResume(success: boolean): void {
  state = {
    ...state,
    resumed: state.resumed + (success ? 1 : 0),
    failed: state.failed + (success ? 0 : 1),
  };
  finishIfComplete();
}

export function failEngineResumeDiscovery(): void {
  beginEngineResume(1);
  recordEngineResume(false);
}

export function getEngineResumeHealth(): EngineResumeHealth {
  return { ...state };
}
