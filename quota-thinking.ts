/**
 * Pi Coding Agent: Codex quota-aware thinking controller
 *
 * Automatically tunes reasoning effort to a linear 5-hour consumption target.
 * Project install: .pi/extensions/quota-thinking.ts; global install: ~/.pi/agent/extensions/quota-thinking.ts.
 * Uses Pi's existing openai-codex OAuth credential, never refreshes or writes it.
 * Endpoint is an undocumented OpenAI endpoint, so it can change.
 */

import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Level = "minimal" | "low" | "medium" | "high" | "xhigh";

type RateWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;             // UNIX seconds
  reset_after_seconds?: number;  // remaining seconds
};

type RateLimit = {
  primary_window?: RateWindow | null;
  secondary_window?: RateWindow | null;
};

type UsageResponse = { rate_limit?: RateLimit | null };

type Snapshot = {
  used: number;
  remaining: number;
  resetAt: number;
  durationSec: number;
  weekly?: {
    used: number;
    remaining: number;
    resetAt: number;
    durationSec: number;
  };
  fetchedAt: number;
};

const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 7_000;
const FIVE_HOURS_SEC = 5 * 60 * 60;
const WEEK_SEC = 7 * 24 * 60 * 60;
const DEFAULT_MODEL_ID = "gpt-6-luna";
const SURPLUS_MODEL_ID = "gpt-6.1-sol";
const LEVEL_ORDER: Level[] = ["minimal", "low", "medium", "high", "xhigh"];

function clamp(n: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, n));
}

function asValidWindow(value: RateWindow | null | undefined) {
  if (!value || typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent)) return null;
  const durationSec = Number(value.limit_window_seconds ?? 0);
  const resetAt = typeof value.reset_at === "number" && Number.isFinite(value.reset_at) && value.reset_at > 0
    ? Number(value.reset_at) * 1000
    : typeof value.reset_after_seconds === "number" && Number.isFinite(value.reset_after_seconds) && value.reset_after_seconds > 0
      ? Date.now() + Number(value.reset_after_seconds) * 1000
      : 0;
  if (durationSec <= 0 || resetAt <= 0) return null;
  return {
    used: clamp(Number(value.used_percent), 0, 100),
    remaining: clamp(100 - Number(value.used_percent), 0, 100),
    resetAt,
    durationSec,
  };
}

function parseUsage(payload: UsageResponse): Snapshot | null {
  const rate = payload.rate_limit;
  if (!rate) return null;
  const windows = [rate.primary_window, rate.secondary_window]
    .map(asValidWindow)
    .filter((w): w is NonNullable<typeof w> => w !== null);
  // Classify by reported duration, not by primary/secondary field name.
  const five = windows.find(w => Math.abs(w.durationSec - FIVE_HOURS_SEC) <= 3600);
  if (!five) return null; // Fail safe if only a weekly window is exposed.
  const weekly = windows.find(w => Math.abs(w.durationSec - WEEK_SEC) <= 24 * 3600);
  return { ...five, weekly, fetchedAt: Date.now() };
}

function targetRemaining(snapshot: { durationSec: number; resetAt: number }): number {
  const secondsLeft = Math.max(0, (snapshot.resetAt - Date.now()) / 1000);
  return clamp(100 * secondsLeft / snapshot.durationSec, 0, 100);
}

function limitLevel(level: Level, ceiling: Level): Level {
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(level), LEVEL_ORDER.indexOf(ceiling))];
}

/** Recommended baseline based on deviation from the linear consumption curve. */
function decide(snapshot: Snapshot): { level: Level; target: number; gap: number; reason: string; modelId: string } {
  const target = targetRemaining(snapshot);
  const gap = snapshot.remaining - target;
  // Default effort levels follow the documented pace-gap thresholds.
  let level: Level = gap >= 10 ? "xhigh"
    : gap > -10 ? "high"
    : "medium";
  let reason = "5h pace";
  if (snapshot.remaining <= 3) {
    level = "minimal";
    reason = "5h quota almost exhausted";
  }
  // Weekly quota is a separate constraint; use its own proportional pace.
  // This is a ceiling, not a promise that changing effort saves the quota.
  if (snapshot.weekly) {
    const weeklyGap = snapshot.weekly.remaining - targetRemaining(snapshot.weekly);
    if (snapshot.weekly.remaining <= 3 || weeklyGap <= -30) {
      level = limitLevel(level, "minimal");
      reason = "weekly quota critically behind pace";
    } else if (snapshot.weekly.remaining <= 10 || weeklyGap <= -15) {
      level = limitLevel(level, "low");
      reason = "weekly quota behind pace";
    }
  }
  // A five-hour surplus of at least 20 points takes precedence over all quota
  // safeguards and uses the surplus model at medium.
  const modelId = gap >= 20 ? SURPLUS_MODEL_ID : DEFAULT_MODEL_ID;
  if (gap >= 20) {
    level = "medium";
    reason = "5h quota far ahead of pace";
  }
  return { level, target, gap, reason, modelId };
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let showDeviationWhenOff = true;
  let applyGeneration = 0;
  let controlledModelSelection = "";
  let snapshot: Snapshot | null = null;
  let lastAttempt = 0;
  let pending: Promise<Snapshot | null> | null = null;
  let lastProblem = "";

  async function refresh(force = false): Promise<Snapshot | null> {
    if (!force && Date.now() - lastAttempt < CACHE_MS) return snapshot;
    if (pending) return pending;
    lastAttempt = Date.now();
    pending = (async () => {
      // Read ONLY Pi's existing Codex OAuth login. No token rotation or writes.
      const credential = readStoredCredential("openai-codex");
      if (credential?.type !== "oauth" || !credential.access) {
        throw new Error("No openai-codex OAuth credential. Run /login openai-codex.");
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credential.access}`,
        Accept: "application/json",
      };
      if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
      const response = await fetch(ENDPOINT, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Usage endpoint HTTP ${response.status}`);
      const parsed = parseUsage(await response.json() as UsageResponse);
      if (!parsed) throw new Error("A valid five-hour usage window is not available");
      snapshot = parsed;
      lastProblem = "";
      return parsed;
    })().catch((error: unknown) => {
      lastProblem = error instanceof Error ? error.message : String(error);
      // Avoid changing thinking based on stale data.
      snapshot = null;
      return null;
    }).finally(() => { pending = null; });
    return pending;
  }

  async function apply(ctx: any, force = false): Promise<void> {
    const generation = applyGeneration;
    if (ctx.model?.provider !== "openai-codex") {
      if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", undefined);
      return;
    }
    if (!enabled && !showDeviationWhenOff) {
      if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", "quota thinking: off");
      return;
    }
    const usage = await refresh(force);
    if (generation !== applyGeneration) return;
    if (ctx.model?.provider !== "openai-codex") {
      if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", undefined);
      return;
    }
    if (!enabled && !showDeviationWhenOff) {
      if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", "quota thinking: off");
      return;
    }
    if (!usage) {
      if (ctx.hasUI) {
        ctx.ui.setStatus("quota-thinking", enabled ? "quota thinking: unavailable" : "quota thinking: off · unavailable");
      }
      return; // Fail open: preserve current thinking level.
    }
    const choice = decide(usage);
    const selectedModel = `openai-codex/${choice.modelId}`;
    if (enabled && choice.modelId) {
      const targetModel = ctx.modelRegistry.find("openai-codex", choice.modelId);
      if (!targetModel) {
        if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", `quota thinking: model unavailable (${selectedModel})`);
        return;
      }
      if (ctx.model?.provider !== targetModel.provider || ctx.model.id !== targetModel.id) {
        controlledModelSelection = targetModel.id;
        try {
          const selected = await pi.setModel(targetModel);
          if (generation !== applyGeneration) return;
          if (ctx.model?.provider !== "openai-codex") {
            if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", undefined);
            return;
          }
          if (!enabled && !showDeviationWhenOff) {
            if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", "quota thinking: off");
            return;
          }
          if (!selected) {
            if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", `quota thinking: cannot select ${selectedModel}`);
            return;
          }
        } catch (error) {
          if (generation !== applyGeneration) return;
          const detail = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", `quota thinking: model switch failed (${detail})`);
          return;
        } finally {
          if (controlledModelSelection === targetModel.id) controlledModelSelection = "";
        }
      }
    }
    if (generation !== applyGeneration) return;
    if (ctx.model?.provider !== "openai-codex") {
      if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", undefined);
      return;
    }
    if (!enabled && !showDeviationWhenOff) {
      if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", "quota thinking: off");
      return;
    }
    if (enabled && pi.getThinkingLevel() !== choice.level) pi.setThinkingLevel(choice.level);
    if (ctx.hasUI) {
      if (!enabled) {
        const sign = choice.gap >= 0 ? "+" : "";
        ctx.ui.setStatus("quota-thinking", `quota thinking: off · ${sign}${choice.gap.toFixed(1)} pp`);
        return;
      }
      ctx.ui.setStatus("quota-thinking", `${choice.gap.toFixed(1)} pp`);
    }
  }

  // Initial decision happens before the agent uses any reasoning on the prompt.
  pi.on("before_agent_start", async (_event, ctx) => { await apply(ctx); });
  // During multi-tool/multi-turn tasks, adjust again between model responses.
  pi.on("turn_end", async (_event, ctx) => { await apply(ctx); });
  pi.on("model_select", async (_event, ctx) => {
    if (ctx.model?.provider === "openai-codex" && ctx.model.id === controlledModelSelection) {
      controlledModelSelection = "";
      return;
    }
    applyGeneration++;
    if (ctx.model?.provider !== "openai-codex" && ctx.hasUI) {
      ctx.ui.setStatus("quota-thinking", undefined);
    }
  });

  pi.registerCommand("quota-thinking", {
    description: "Control quota-aware thinking: /quota-thinking [status|on|off|refresh|setting [on|off]]",
    getArgumentCompletions: (prefix) => {
      const actions = [
        { value: "status", label: "status", description: "Show quota and thinking status" },
        { value: "on", label: "on", description: "Resume automatic control" },
        { value: "off", label: "off", description: "Pause automatic control" },
        { value: "refresh", label: "refresh", description: "Fetch quota and apply settings" },
        { value: "setting", label: "setting", description: "Show off-state deviation display setting" },
        { value: "setting on", label: "setting on", description: "Show quota deviation while off" },
        { value: "setting off", label: "setting off", description: "Hide quota deviation while off" },
      ];
      const query = prefix.trim().toLowerCase();
      const matches = actions.filter(action => action.value.startsWith(query));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const [action = "status", settingValue, ...extra] = (args || "status").trim().toLowerCase().split(/\s+/);
      if (action === "setting") {
        if (extra.length > 0 || (settingValue && !["on", "off"].includes(settingValue))) {
          if (ctx.hasUI) ctx.ui.notify("Usage: /quota-thinking setting [on|off]", "warning");
          return;
        }
        if (settingValue) {
          const next = settingValue === "on";
          if (next !== showDeviationWhenOff) {
            showDeviationWhenOff = next;
            applyGeneration++;
          }
        }
        if (settingValue && !enabled && ctx.hasUI) await apply(ctx, true);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Quota deviation while off: ${showDeviationWhenOff ? "ON" : "OFF"} (runtime only)`,
            "info",
          );
        }
        return;
      }
      if (settingValue || extra.length > 0) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /quota-thinking [status|on|off|refresh|setting [on|off]]", "warning");
        return;
      }
      if (action === "off") {
        enabled = false;
        applyGeneration++;
        if (ctx.hasUI) ctx.ui.setStatus("quota-thinking", "quota thinking: off");
        await apply(ctx, true);
        if (ctx.hasUI) ctx.ui.notify("Quota-aware thinking disabled; current level is unchanged", "info");
        return;
      }
      if (action === "on") {
        enabled = true;
        applyGeneration++;
      }
      if (!["status", "refresh", "on"].includes(action)) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /quota-thinking [status|on|off|refresh|setting [on|off]]", "warning");
        return;
      }
      if (action === "on" || action === "refresh") await apply(ctx, true);
      else if (!snapshot) await refresh(true);
      const usage = snapshot;
      if (!ctx.hasUI) return;
      if (!usage) {
        ctx.ui.notify(`Quota: unavailable (${lastProblem || "no valid snapshot"})`, "warning");
        return;
      }
      const d = decide(usage);
      const weekly = usage.weekly
        ? `; weekly ${usage.weekly.remaining.toFixed(1)}% left`
        : "; weekly unavailable";
      ctx.ui.notify(
        `Quota thinking ${enabled ? "ON" : "OFF"}: 5h ${usage.remaining.toFixed(1)}% left; ` +
        `target ${d.target.toFixed(1)}%; deviation ${d.gap.toFixed(1)} pp; ` +
        `recommended ${d.level}; current ${pi.getThinkingLevel()} (${d.reason})${weekly}`,
        "info",
      );
    },
  });
}
