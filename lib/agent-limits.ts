// Hard ceilings for one coding run. They bound token spend and wall-clock time
// even if the model never finishes or alternates between different actions.
export type AgentLimits = { maxSteps: number; maxMs: number };

function bounded(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  const n =
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function agentLimits(env: NodeJS.ProcessEnv = process.env): AgentLimits {
  return {
    maxSteps: bounded(env.AGENT_MAX_STEPS, 40, 1, 200),
    maxMs: bounded(env.AGENT_MAX_SECONDS, 1500, 60, 3600) * 1000,
  };
}

// Throws before another model call or sandbox action would exceed a ceiling.
// Messages deliberately contain "time limit" / "step limit": the worker marks
// such runs as blocked (retryable by the user) rather than failed.
export function assertWithinAgentLimits(
  state: { steps: number; startedAt: number; now?: number },
  limits: AgentLimits = agentLimits(),
) {
  const elapsed = (state.now ?? Date.now()) - state.startedAt;
  if (elapsed > limits.maxMs)
    throw new Error(
      `Execution time limit reached (${Math.round(limits.maxMs / 60000)} minutes). Retry with clearer instructions or a narrower issue.`,
    );
  if (state.steps >= limits.maxSteps)
    throw new Error(
      `Agent step limit reached (${limits.maxSteps} steps). Retry with clearer instructions or a narrower issue.`,
    );
}
