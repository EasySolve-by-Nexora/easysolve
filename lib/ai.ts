import { setTimeout as delay } from "node:timers/promises";
import { providerConfig, generateAI } from "./providers";
import type OpenAI from "openai";
import {
  limit,
  type DeepSeekMessage,
  type OutputFormat,
} from "./providers/shared";
import { db } from "./db";
import {
  allowanceWindow,
  monthStart,
  nextMonth,
  settings,
  planLimits,
} from "./policy";
import { HttpError } from "./security";
import { providerFingerprint } from "./provider-status";

export async function reserveAIRequestSlots(
  buckets: readonly { key: string; limit: number }[],
  windowMs = 60_000,
): Promise<Date | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('easysolve:ai-request-slots'))`;
    const rows = await tx.rateLimit.findMany({
      where: { key: { in: buckets.map(({ key }) => key) } },
    });
    const now = Date.now();
    const active = new Map(
      rows
        .filter((row) => row.expiresAt.getTime() > now)
        .map((row) => [row.key, row]),
    );
    let retryAt: Date | null = null;
    for (const bucket of buckets) {
      const row = active.get(bucket.key);
      if (
        row &&
        row.count >= bucket.limit &&
        (!retryAt || row.expiresAt > retryAt)
      )
        retryAt = row.expiresAt;
    }
    if (retryAt) return retryAt;

    const initial = { count: 1, expiresAt: new Date(now + windowMs) };
    for (const { key } of buckets) {
      await tx.rateLimit.upsert({
        where: { key },
        create: { key, ...initial },
        update: active.has(key) ? { count: { increment: 1 } } : initial,
      });
    }
    return null;
  });
}

async function waitForAIRequestSlots(
  userId: string,
  runId?: string,
  signal?: AbortSignal,
) {
  const buckets = [
    { key: `ai:${userId}`, limit: limit("AI_REQUESTS_PER_MINUTE", 20) },
    { key: "ai:global", limit: limit("AI_GLOBAL_REQUESTS_PER_MINUTE", 60) },
  ];
  let previousStage: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const retryAt = await reserveAIRequestSlots(buckets);
    if (!retryAt) {
      if (previousStage && runId)
        await db.run.updateMany({
          where: { id: runId, userId, status: "running", stage: "ai_wait" },
          data: { stage: previousStage, lastProgressAt: new Date() },
        });
      return;
    }
    if (!runId)
      throw Object.assign(
        new HttpError(
          429,
          "AI requests are temporarily busy. Try again shortly.",
        ),
        {
          retryAt,
        },
      );

    if (previousStage === undefined) {
      const run = await db.run.findFirst({
        where: { id: runId, userId, status: "running" },
        select: { stage: true },
      });
      if (!run) throw Error("Run cancelled");
      previousStage = run.stage === "ai_wait" ? "execution" : run.stage;
      await db.run.updateMany({
        where: { id: runId, userId, status: "running", stage: run.stage },
        data: { stage: "ai_wait", lastProgressAt: new Date() },
      });
    }
    // Keep the current sandbox and transcript while waiting for capacity.
    const resumeAt = retryAt.getTime() + 25 + Math.floor(Math.random() * 175);
    while (Date.now() < resumeAt) {
      await delay(
        Math.min(5_000, Math.max(0, resumeAt - Date.now())),
        undefined,
        {
          signal,
        },
      );
      const run = await db.run.findFirst({
        where: { id: runId, userId },
        select: { status: true },
      });
      if (!run || run.status === "cancelled") throw Error("Run cancelled");
    }
  }
}

export class AllowanceError extends Error {
  constructor(
    message: string,
    public reset = nextMonth(),
  ) {
    super(message);
  }
}
export type AIConversation = {
  messages: DeepSeekMessage[];
  calls: { id: string; name: string; arguments: string }[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  maxTokens?: number;
};
export async function ai(
  userId: string,
  purpose: string,
  input: string,
  instructions: string,
  runId?: string,
  tools?: OpenAI.Responses.Tool[],
  format?: OutputFormat,
  conversation?: AIConversation,
) {
  conversation?.signal?.throwIfAborted();
  const provider = providerConfig();
  if (!provider.configured)
    throw new HttpError(
      503,
      `${provider.name} is not configured. Ask the operator to set its server-side API key and restart the app and worker.`,
    );
  await waitForAIRequestSlots(userId, runId, conversation?.signal);
  const admission = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`usage:${userId}`}))`;
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (u.suspendedAt) throw new HttpError(403, "Account suspended");
      const config = settings(u.settings);
      const usage = await tx.usage.aggregate({
        where: { userId, createdAt: { gte: monthStart() } },
        _sum: { total: true },
      });
      const window = allowanceWindow(config);
      const cycle = await tx.usage.aggregate({
        where: { userId, createdAt: { gte: window.start } },
        _sum: { total: true },
      });
      const baseMax =
        conversation?.maxTokens ??
        limit("AI_MAX_OUTPUT_TOKENS", runId ? 4000 : 6000, 128000);
      const max = baseMax;
      const reserve =
        Buffer.byteLength(
          input +
            instructions +
            JSON.stringify([
              tools ?? [],
              format ?? {},
              conversation?.messages ?? [],
            ]),
          "utf8",
        ) +
        512 +
        max;
      const runScoped = !!runId;
      if (
        !runScoped &&
        (usage._sum.total ?? 0) + reserve > planLimits(u).tokens
      )
        throw new AllowanceError(
          "Plan token allowance exhausted; queued until next reset",
          nextMonth(),
        );
      if (
        !runScoped &&
        (cycle._sum.total ?? 0) + reserve > config.monthlyTokens
      )
        throw new AllowanceError(
          "Token allowance exhausted; queued until configured reset",
          window.reset,
        );
      if (
        Buffer.byteLength(
          input +
            instructions +
            JSON.stringify([
              tools ?? [],
              format ?? {},
              conversation?.messages ?? [],
            ]),
        ) > limit("AI_MAX_INPUT_BYTES", 200000)
      )
        throw new HttpError(
          413,
          "AI request exceeds the configured input limit. Narrow the context.",
        );
      // Durable attempts include rejected/interrupted requests; usage rows remain actual receipts only.
      await tx.aIRequest.create({ data: { userId, runId } });
      return { maxTokens: max };
    },
    { timeout: 15000 },
  );
  let result;
  try {
    result = await generateAI({
      input,
      instructions,
      maxTokens: admission.maxTokens,
      tools,
      format,
      history: conversation?.messages,
      signal: conversation?.signal,
      onText: conversation?.onText,
    });
  } catch (error) {
    // A user cancelling (or a dropped connection) says nothing about the provider.
    if (
      conversation?.signal?.aborted ||
      (error as { name?: string })?.name === "AbortError"
    )
      throw error;
    await db.providerConnection.upsert({
      where: { id: provider.id },
      create: {
        id: provider.id,
        fingerprint: providerFingerprint(),
        model: provider.model,
        verifiedAt: new Date(0),
      },
      update: {
        fingerprint: providerFingerprint(),
        model: provider.model,
        verifiedAt: new Date(0),
      },
    });
    throw error;
  }
  await db.$transaction(async (tx) => {
    const usageData = result.usage;
    if (usageData)
      await tx.usage.create({
        data: {
          userId,
          provider: result.provider,
          runId,
          purpose,
          model: result.model,
          input: usageData.input_tokens,
          cached: usageData.input_tokens_details?.cached_tokens ?? 0,
          output: usageData.output_tokens,
          reasoning: usageData.output_tokens_details?.reasoning_tokens ?? 0,
          total: usageData.total_tokens,
        },
      });
    await tx.providerConnection.upsert({
      where: { id: provider.id },
      create: {
        id: provider.id,
        fingerprint: providerFingerprint(),
        model: provider.model,
        verifiedAt: result.failure ? new Date(0) : new Date(),
      },
      update: {
        fingerprint: providerFingerprint(),
        model: provider.model,
        verifiedAt: result.failure ? new Date(0) : new Date(),
      },
    });
  });
  if (result.failure) throw result.failure;
  if (conversation) conversation.calls = result.calls;
  if (result.calls.length > 1) {
    return JSON.stringify({
      answer: "",
      actions: result.calls.map((c) => ({
        type: c.name,
        ...JSON.parse(c.arguments),
      })),
    });
  }
  const call = result.calls[0];
  if (call)
    return JSON.stringify({
      answer: "",
      action: { type: call.name, ...JSON.parse(call.arguments) },
    });
  if (!result.text.trim())
    throw new HttpError(
      502,
      `${provider.name} returned no usable output. No action was applied.`,
    );
  return result.text;
}
