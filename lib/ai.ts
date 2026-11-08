/**
 * The agents' model, with a deterministic fallback.
 *
 * - ANTHROPIC_API_KEY set: Claude (Anthropic Messages API)
 * - otherwise OPENAI_API_KEY set: OpenAI (Chat Completions API)
 * - neither: agents run on built-in rules, so the demo still works end to end
 *
 * Callers use one shape (Claude-style content blocks); the OpenAI path translates.
 */
export type AIMode = "claude" | "openai" | "demo";

/** Tests can script the model's replies to check how Square handles bad or contradictory output. */
type Scripted = (system: string, user: string) => string;
const hook = globalThis as unknown as { __squareScriptedModel?: Scripted };
export function scriptModel(fn: Scripted | null) {
  hook.__squareScriptedModel = fn ?? undefined;
}

export const aiMode = (): AIMode =>
  hook.__squareScriptedModel ? "openai" : process.env.ANTHROPIC_API_KEY ? "claude" : process.env.OPENAI_API_KEY ? "openai" : "demo";
export const aiLabel = () => (aiMode() === "claude" ? "Claude" : aiMode() === "openai" ? "OpenAI" : "built-in rules");

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type ChatMessage = { role: "user" | "assistant"; content: string | Block[] };
export type ClaudeTool = { name: string; description: string; input_schema: Record<string, unknown> };
type Reply = { content: Block[]; stop_reason: string };

/* ---------------- Claude ---------------- */

async function callClaude(system: string, messages: ChatMessage[], tools: ClaudeTool[] | undefined, maxTokens: number): Promise<Reply> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages, ...(tools?.length ? { tools } : {}) }),
  });
  if (!res.ok) throw new Error(`Claude request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as Reply;
}

/* ---------------- OpenAI ---------------- */

type OAIMessage =
  | { role: "system" | "user"; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAI(system: string, messages: ChatMessage[]): OAIMessage[] {
  const out: OAIMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const uses = m.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      out.push({
        role: "assistant",
        content: text || null,
        ...(uses.length ? { tool_calls: uses.map((u) => ({ id: u.id, type: "function" as const, function: { name: u.name, arguments: JSON.stringify(u.input) } })) } : {}),
      });
      continue;
    }
    const results = m.content.filter((b): b is Extract<Block, { type: "tool_result" }> => b.type === "tool_result");
    for (const r of results) out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
    type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
    const parts: Part[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out;
}

async function callOpenAI(system: string, messages: ChatMessage[], tools: ClaudeTool[] | undefined, maxTokens: number): Promise<Reply> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: toOpenAI(system, messages),
      // Reasoning models spend part of this budget thinking, so allow more than the visible reply needs.
      max_completion_tokens: Math.max(maxTokens * 4, 2000),
      ...(tools?.length
        ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as {
    choices: { finish_reason: string; message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  };
  const msg = j.choices[0].message;
  const content: Block[] = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(c.function.arguments || "{}");
    } catch {}
    content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
  }
  return { content, stop_reason: msg.tool_calls?.length ? "tool_use" : "end_turn" };
}

/* ---------------- Shared API ---------------- */

function call(system: string, messages: ChatMessage[], tools?: ClaudeTool[], maxTokens = 900): Promise<Reply> {
  if (hook.__squareScriptedModel) {
    const last = messages[messages.length - 1];
    const user = typeof last.content === "string" ? last.content : textOf(last.content);
    return Promise.resolve({ content: [{ type: "text", text: hook.__squareScriptedModel(system, user) }], stop_reason: "end_turn" });
  }
  return aiMode() === "openai" ? callOpenAI(system, messages, tools, maxTokens) : callClaude(system, messages, tools, maxTokens);
}

const textOf = (blocks: Block[]) =>
  blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

export async function ask(system: string, user: string | Block[], maxTokens = 600) {
  const r = await call(system, [{ role: "user", content: user }], undefined, maxTokens);
  return textOf(r.content);
}

/** Ask for JSON and parse the first object in the reply. */
export async function askJSON<T>(system: string, user: string | Block[], maxTokens = 900): Promise<T> {
  const raw = await ask(`${system}\n\nRespond with a single JSON object and nothing else.`, user, maxTokens);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`${aiLabel()} did not return JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

/** Simple tool-use loop. `run` executes a tool and returns its text result. */
export async function askWithTools(
  system: string,
  user: string,
  tools: ClaudeTool[],
  run: (name: string, input: Record<string, unknown>) => Promise<string>,
  maxSteps = 4,
) {
  const messages: ChatMessage[] = [{ role: "user", content: user }];
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const r = await call(system, messages, tools, 900);
    messages.push({ role: "assistant", content: r.content });
    const uses = r.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    if (r.stop_reason !== "tool_use" || uses.length === 0) return { text: textOf(r.content), calls };
    const results: Block[] = [];
    for (const u of uses) {
      calls.push({ name: u.name, input: u.input });
      try {
        results.push({ type: "tool_result", tool_use_id: u.id, content: (await run(u.name, u.input)).slice(0, 6000) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: u.id, content: String(e), is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "", calls };
}

export function imageBlock(dataUrl: string): Block {
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) throw new Error("Receipt image must be a base64 data URL.");
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}
