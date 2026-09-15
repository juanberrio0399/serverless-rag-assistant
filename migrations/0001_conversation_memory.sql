-- Conversation memory for POST /ask (see src/memory.js).
-- Stores only what the model needs: no IP address or other request metadata.
-- Retention is enforced by the Worker: 7 days and at most 10 rows per conversation.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL -- Unix epoch milliseconds
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);
