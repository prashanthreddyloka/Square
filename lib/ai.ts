/**
 * Claude (Anthropic Messages API) with a deterministic fallback.
 * Set ANTHROPIC_API_KEY to use Claude; otherwise agents run on rule-based logic
 * so the demo still works end to end.
 */
export const aiMode = (): "claude" | "demo" => (process.env.ANTHROPIC_API_KEY ? "claude" : "demo");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type ChatMessage = { role: "user" | "assistant"; content: string | Block[] };
export type ClaudeTool = { name: string; description: string; input_schema: Record<string, unknown> };

async function call(system: string, messages: ChatMessage[], tools?: ClaudeTool[], maxTokens = 900) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages, ...(tools?.length ? { tools } : {}) }),
  });
  if (!res.ok) throw new Error(`Claude request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { content: Block[]; stop_reason: string };
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
  if (start < 0 || end < start) throw new Error(`Claude did not return JSON: ${raw.slice(0, 200)}`);
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
