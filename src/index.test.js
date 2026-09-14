import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("RAG Assistant Worker", () => {
  it("responds to /ask with an answer field", async () => {
    const response = await SELF.fetch("http://localhost/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("answer");
  });
});
