import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getUsageSummary } from "../services/usageLogger";

const router = Router();

router.use(requireAuth, requireAdmin);

type ProviderUsage = {
  name: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  status: "ok" | "warning" | "critical" | "unknown";
  resetTime?: string | null;
  note?: string | null;
  highlight?: string | null;
};

function deriveStatus(remaining: number | null, limit: number | null): ProviderUsage["status"] {
  if (remaining === null || limit === null || limit === 0) return "unknown";
  const pct = remaining / limit;
  if (pct > 0.25) return "ok";
  if (pct > 0.1)  return "warning";
  return "critical";
}

async function fetchSerperUsage(): Promise<ProviderUsage> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return { name: "Serper", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: "SERPER_API_KEY not set" };

  try {
    const r = await fetch("https://google.serper.dev/account", {
      headers: { "X-API-KEY": apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    // Response shape: { balance: number (credits remaining), rateLimit: number }
    const data = await r.json() as { balance?: number; rateLimit?: number };

    const remaining   = data.balance ?? null;
    const limit       = 50_000;
    const used        = remaining !== null ? limit - remaining : null;
    const percentUsed = used !== null ? Math.round((used / limit) * 100) : null;

    return {
      name: "Serper",
      used,
      limit,
      remaining,
      percentUsed,
      status: remaining === null ? "unknown" : remaining > 1000 ? "ok" : remaining > 200 ? "warning" : "critical",
      note: `${remaining?.toLocaleString()} of ${limit.toLocaleString()} credits remaining`,
    };
  } catch (e: any) {
    return { name: "Serper", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: e.message };
  }
}

// Groq pricing: USD per 1M tokens (input / output)
const GROQ_PRICING: Record<string, { input: number; output: number }> = {
  "llama-3.1-8b-instant":  { input: 0.05,  output: 0.08  },
  "llama-4-scout-17b":     { input: 0.11,  output: 0.34  },
};
const GROQ_DEFAULT_PRICE = { input: 0.10, output: 0.10 };

function groqCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = GROQ_PRICING[model] ?? GROQ_DEFAULT_PRICE;
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}

function fetchGroqUsage(): ProviderUsage {
  const rows = getUsageSummary().filter(r => r.provider === "groq");
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);

  if (totalCalls === 0) {
    return { name: "Groq", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: "No calls logged yet" };
  }

  const totalCost   = rows.reduce((s, r) => s + groqCost(r.model, r.prompt_tokens, r.completion_tokens), 0);
  const totalTokens = rows.reduce((s, r) => s + r.total_tokens, 0);
  const breakdown   = rows.map(r => {
    const cost = groqCost(r.model, r.prompt_tokens, r.completion_tokens);
    return `${r.model}: ${r.total_tokens.toLocaleString()} tok · $${cost.toFixed(4)} (${r.calls} calls)`;
  }).join("\n");

  return {
    name: "Groq",
    used: totalTokens,
    limit: null,
    remaining: null,
    percentUsed: null,
    status: "ok",
    highlight: `$${totalCost.toFixed(4)}`,
    note: breakdown,
  };
}

async function fetchProxyCheapUsage(): Promise<ProviderUsage> {
  const apiKey    = process.env.PROXYCHEAP_API_KEY;
  const apiSecret = process.env.PROXYCHEAP_API_SECRET;
  if (!apiKey || !apiSecret) return { name: "ProxyCheap", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: "PROXYCHEAP_API_KEY / PROXYCHEAP_API_SECRET not set" };

  try {
    const r = await fetch("https://api.proxy-cheap.com/proxies", {
      headers: { "X-Api-Key": apiKey, "X-Api-Secret": apiSecret },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json() as { proxies?: { bandwidth?: { total: number | null; used: number } }[] };
    const proxies = data.proxies ?? [];

    // Sum across all proxies; bandwidth values are in GB
    const totalGB = proxies.reduce((s, p) => s + (p.bandwidth?.total ?? 0), 0);
    const usedGB  = proxies.reduce((s, p) => s + (p.bandwidth?.used ?? 0), 0);
    const usedMB  = Math.round(usedGB * 1024);
    const totalMB = Math.round(totalGB * 1024);
    const percentUsed = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : null;

    const status: ProviderUsage["status"] =
      percentUsed === null ? "unknown" :
      percentUsed < 75     ? "ok" :
      percentUsed < 90     ? "warning" :
                             "critical";

    return {
      name: "ProxyCheap",
      used: usedMB,
      limit: totalMB,
      remaining: totalMB - usedMB,
      percentUsed,
      status,
      note: `${usedMB} MB used of ${totalGB} GB`,
    };
  } catch (e: any) {
    return { name: "ProxyCheap", used: null, limit: null, remaining: null, percentUsed: null, status: "unknown", note: e.message };
  }
}

router.get("/usage", async (_req, res) => {
  const [serper, proxycheap] = await Promise.all([
    fetchSerperUsage(),
    fetchProxyCheapUsage(),
  ]);
  const groq = fetchGroqUsage();

  res.json({ providers: [serper, groq, proxycheap] });
});

export default router;
