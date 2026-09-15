// Optional conversation memory for /ask, stored in Cloudflare D1 (binding: DB).
// Without the binding, or if D1 fails, /ask stays stateless and behaves exactly as before.
//
// Privacy (the demo is public): only the conversation id, the role, the text of the question or answer
// (capped) and a timestamp are stored. No IP address, user agent or other request data.
// Retention: rows older than RETENTION_DAYS are deleted opportunistically on each write, and each
// conversation keeps at most MAX_MESSAGES rows.

export const MEMORY_TURNS = 5;                      // question/answer pairs sent back to the model
export const MAX_MESSAGES = MEMORY_TURNS * 2;       // rows kept per conversation
export const MAX_MEMORY_CHARS = 2000;               // cap on each stored message
export const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Returns { id } (the client's id, or a new one when absent) or { error } when the id is malformed.
export function resolveConversationId(raw) {
  if (raw === undefined || raw === null || raw === "") return { id: crypto.randomUUID() };
  if (typeof raw !== "string" || !ID_PATTERN.test(raw)) {
    return { error: "'conversationId' must be 8-64 characters: letters, digits, '-' or '_'." };
  }
  return { id: raw };
}

// Oldest first, ready to be placed between the system prompt and the new question.
export async function loadHistory(db, conversationId) {
  try {
    const { results } = await db
      .prepare("SELECT role, content FROM messages WHERE conversation_id = ?1 AND created_at >= ?2 ORDER BY id DESC LIMIT ?3")
      .bind(conversationId, Date.now() - RETENTION_MS, MAX_MESSAGES)
      .all();
    return (results ?? []).reverse().map((r) => ({ role: r.role, content: r.content }));
  } catch (e) {
    console.error("Memory read:", e.message);
    return [];
  }
}

export async function saveTurn(db, conversationId, question, answer, now = Date.now()) {
  const cap = (text) => String(text).slice(0, MAX_MEMORY_CHARS);
  try {
    await db.batch([
      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?1, 'user', ?2, ?3)")
        .bind(conversationId, cap(question), now),
      db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?1, 'assistant', ?2, ?3)")
        .bind(conversationId, cap(answer), now),
      // Keep only the newest MAX_MESSAGES rows of this conversation.
      db.prepare("DELETE FROM messages WHERE conversation_id = ?1 AND id NOT IN (SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id DESC LIMIT ?2)")
        .bind(conversationId, MAX_MESSAGES),
      // Retention for every conversation.
      db.prepare("DELETE FROM messages WHERE created_at < ?1").bind(now - RETENTION_MS),
    ]);
  } catch (e) {
    console.error("Memory write:", e.message);
  }
}

// A follow-up such as "and how often?" retrieves poorly on its own, so the previous question is
// added to the retrieval query. The prompt still carries the full recent history.
export function retrievalQuery(question, history) {
  const previous = history.filter((m) => m.role === "user").at(-1)?.content;
  return previous ? `${previous}\n${question}` : question;
}
