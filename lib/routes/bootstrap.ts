import { entitlementSummary } from "../entitlements";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "../db";
import {
  allowanceWindow,
  monthStart,
  nextMonth,
  settings,
  planLimits,
} from "../policy";
import type { RouteContext } from "./types";
const id = z.string().min(1).max(100);
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status });
export async function handleBootstrap({
  request,
  path,
  body,
  url,
  u,
}: RouteContext) {
  const route = path.join("/");
  const method = request.method;
  if (route === "bootstrap") {
    const [
      identities,
      repositories,
      issues,
      runs,
      messages,
      usage,
      applications,
      proposals,
      jobs,
    ] = await Promise.all([
      db.identity.findMany({
        where: { userId: u.id },
        select: {
          id: true,
          login: true,
          active: true,
          usable: true,
          status: true,
          syncedAt: true,
        },
      }),
      db.repository.findMany({ where: { userId: u.id } }),
      db.issue.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: "desc" },
        take: 2000,
      }),
      db.run.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: "desc" },
        take: 300,
        select: {
          id: true,
          repo: true,
          title: true,
          status: true,
          stage: true,
          blockedReason: true,
          toolRounds: true,
          repairAttempts: true,
          queueWaitMs: true,
          checkoutMs: true,
          analysisMs: true,
          dependencyMs: true,
          aiMs: true,
          editMs: true,
          executionMs: true,
          validationMs: true,
          prPreparationMs: true,
          lastProgressAt: true,
          branch: true,
          prUrl: true,
          prNumber: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
          mode: true,
          error: true,
        },
      }),
      // Newest 500 messages, returned oldest-first as the UI expects.
      db.message
        .findMany({
          where: { userId: u.id },
          orderBy: { createdAt: "desc" },
          take: 500,
        })
        .then((rows) => rows.reverse()),
      // One row per UTC day with exact sums, not one row per AI request: the
      // usage page only totals and charts them.
      db.$queryRaw<
        {
          createdAt: Date;
          input: number;
          cached: number;
          reasoning: number;
          output: number;
          total: number;
          requests: number;
        }[]
      >`SELECT date_trunc('day', "createdAt") AS "createdAt",
          COALESCE(SUM("input"), 0)::float8 AS "input",
          COALESCE(SUM("cached"), 0)::float8 AS "cached",
          COALESCE(SUM("reasoning"), 0)::float8 AS "reasoning",
          COALESCE(SUM("output"), 0)::float8 AS "output",
          COALESCE(SUM("total"), 0)::float8 AS "total",
          COUNT(*)::float8 AS "requests"
        FROM "Usage"
        WHERE "userId" = ${u.id} AND "createdAt" >= ${monthStart()}
        GROUP BY 1 ORDER BY 1 DESC`,
      db.application.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: "desc" },
      }),
      db.proposal.findMany({
        where: {
          userId: u.id,
          state: { notIn: ["issue_publishing", "issue_published"] },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      db.job.findMany({
        where: {
          userId: u.id,
          status: { in: ["queued", "running", "failed"] },
        },
        select: {
          id: true,
          kind: true,
          status: true,
          error: true,
          availableAt: true,
        },
      }),
    ]);
    const fullSettings = settings(u.settings);
    const {
      deepseekInputPrice: _inputPrice,
      deepseekCachedPrice: _cachedPrice,
      deepseekOutputPrice: _outputPrice,
      ...customerSettings
    } = fullSettings;
    const window = allowanceWindow(fullSettings);
    const cycleUsage = await db.usage.aggregate({
      where: { userId: u.id, createdAt: { gte: window.start } },
      _sum: { total: true },
    });
    const entitlements = await entitlementSummary(u.id);
    return json({
      allowance: {
        start: window.start,
        reset: window.reset,
        total: cycleUsage._sum.total ?? 0,
      },
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
      },
      identities,
      repositories,
      issues,
      runs,
      messages,
      usage,
      applications,
      proposals,
      jobs,
      settings: customerSettings,
      health: { encryption: !!process.env.TOKEN_ENCRYPTION_KEY },
      limits: {
        jobs: planLimits(u).jobs,
        tokens: planLimits(u).tokens,
        reset: nextMonth(),
      },
      plan: entitlements.name,
      entitlements,
    });
  }
  return undefined;
}
