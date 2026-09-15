// Optional reasoning mode for /ask: DeepSeek-R1 (distilled, on Workers AI) thinks before it answers.
// Off by default: it is slower (~10-30 s) and one answer used ~110 of the 10,000 free daily Workers AI
// neurons in testing, so callers opt in with {"reasoning": true} or ?reasoning=true.

export const REASONING_MODEL = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
export const REASONING_MAX_TOKENS = 1536; // room for thinking + answer (the model default of 256 cuts the answer off)
export const MAX_REASONING_CHARS = 4000;  // cap on the thinking returned to the client

const ON = new Set([true, 1, "true", "1"]);

export function wantsReasoning(body, url) {
  return ON.has(body?.reasoning) || ON.has(url?.searchParams?.get("reasoning"));
}

// R1 writes "<think>…</think>" before the answer; Workers AI sometimes drops the opening tag.
// Without a closing tag the output is either a plain answer or a thought cut off by the token limit.
export function splitReasoning(raw, { hitLimit = false } = {}) {
  const text = String(raw ?? "");
  const close = text.lastIndexOf("</think>");
  if (close === -1) {
    const opened = /<think>/i.test(text);
    if (opened || hitLimit) return { answer: "", reasoning: text.replace(/<think>/i, "").trim(), truncated: true };
    return { answer: text.trim(), reasoning: "", truncated: false };
  }
  return {
    answer: text.slice(close + "</think>".length).trim(),
    reasoning: text.slice(0, close).replace(/^\s*<think>/i, "").trim(),
    truncated: false,
  };
}

// Returns { answer, reasoning } or null when the model fails or runs out of tokens, so /ask can fall back.
export async function reasoningAnswer(env, messages) {
  // DeepSeek recommends no system prompt for R1: every instruction goes in the user turn.
  const instructions = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  // Earlier turns from conversation memory are written out as a transcript before the current question.
  const turns = messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
  const current = turns.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const earlier = turns.slice(0, turns.findLastIndex((m) => m.role === "user"))
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`).join("\n");
  const question = earlier ? `Conversation so far:\n${earlier}\n\n${current}` : current;
  const prompt = [{
    role: "user",
    content: `${instructions}\nThink step by step before answering. After thinking, write only the final answer.\n\n${question}`,
  }];

  try {
    const res = await env.AI.run(REASONING_MODEL, { messages: prompt, max_tokens: REASONING_MAX_TOKENS, temperature: 0.6 });
    const hitLimit = (res?.usage?.completion_tokens ?? 0) >= REASONING_MAX_TOKENS;
    const out = splitReasoning(res?.response, { hitLimit });
    if (out.truncated || !out.answer) return null;
    return { answer: out.answer, reasoning: out.reasoning.slice(0, MAX_REASONING_CHARS) };
  } catch (e) {
    console.error("Reasoning model:", e.message);
    return null;
  }
}
