// Hard ceilings for one coding run. They bound token spend and wall-clock time
// even if the model never finishes or alternates between different actions.
export type AgentLimits = { maxSteps: number; maxMs: number };
export type AgentProfile = "fast" | "complex";

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

export function agentLimits(
  env: Record<string, string | undefined> = process.env,
  profile: AgentProfile = "fast",
): AgentLimits {
  const complex = profile === "complex";
  return {
    maxSteps: bounded(
      complex ? env.AGENT_COMPLEX_MAX_STEPS : env.AGENT_MAX_STEPS,
      complex ? 24 : 12,
      1,
      200,
    ),
    maxMs:
      bounded(
        complex ? env.AGENT_COMPLEX_MAX_SECONDS : env.AGENT_MAX_SECONDS,
        complex ? 900 : 300,
        60,
        3600,
      ) * 1000,
  };
}

// Coding replies are structured actions, not prose. Keeping them concise cuts
// token use and response latency while still leaving room for a complete edit.
export function agentOutputTokens(
  env: Record<string, string | undefined> = process.env,
  profile: AgentProfile = "fast",
) {
  const complex = profile === "complex";
  return bounded(
    complex
      ? env.AGENT_COMPLEX_MAX_OUTPUT_TOKENS
      : env.AGENT_MAX_OUTPUT_TOKENS,
    complex ? 1800 : 1200,
    256,
    2500,
  );
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
