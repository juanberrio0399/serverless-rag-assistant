import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chunkText, splitSentences, splitUnits, normalizeText, CHUNK_SIZE, CHUNK_MAX, AVG_CHUNK_CHARS } from "../src/chunker.js";

describe("normalizeText", () => {
  test("keeps the block structure and collapses the rest", () => {
    assert.equal(normalizeText("a  b\r\n  c\n\n\n\nd  "), "a b\nc\n\nd");
  });
});

describe("splitSentences", () => {
  test("splits on sentence ends", () => {
    assert.deepEqual(splitSentences("One idea. Another idea! A third? Yes."), ["One idea.", "Another idea!", "A third?", "Yes."]);
  });
  test("does not split abbreviations, decimals, versions or URLs", () => {
    assert.deepEqual(splitSentences("Use e.g. Workers AI. See developers.cloudflare.com/ai for v1.5 models."),
      ["Use e.g. Workers AI.", "See developers.cloudflare.com/ai for v1.5 models."]);
    assert.equal(splitSentences("Vectorize costs approx. 0.04 USD per query.").length, 1);
  });
});

describe("splitUnits", () => {
  const doc = [
    "# Title", "", "First sentence. Second sentence.", "",
    "## Section", "", "- item one", "- item two", "",
    "```js", "const x = 1;", "```", "",
  ].join("\n");

  test("carries the heading path and keeps code fences whole", () => {
    const units = splitUnits(doc);
    assert.deepEqual(units.map((u) => u.text), [
      "First sentence.", "Second sentence.", "- item one", "- item two", "```js\nconst x = 1;\n```",
    ]);
    assert.deepEqual(units[0].heading, ["Title"]);
    assert.deepEqual(units.at(-1).heading, ["Title", "Section"]);
    assert.equal(units.at(-1).atomic, true);
  });
  test("a heading closes the sections below it", () => {
    const units = splitUnits("# A\n\n## B\n\ntext b\n\n# C\n\ntext c");
    assert.deepEqual(units.map((u) => u.heading), [["A", "B"], ["C"]]);
  });
});

describe("chunkText", () => {
  test("keeps small documents in one chunk and prefixes the heading path", () => {
    const chunks = chunkText("# Guide\n\n## Setup\n\nRun wrangler deploy. It publishes the Worker.");
    assert.deepEqual(chunks, ["# Guide > Setup\nRun wrangler deploy. It publishes the Worker."]);
  });
  test("never ends a chunk in the middle of a sentence", () => {
    const sentence = "Vectorize stores the embeddings produced by the model and searches them. ";
    for (const chunk of chunkText(sentence.repeat(40))) {
      assert.match(chunk.trim(), /[.!?:;]$/);
    }
  });
  test("starts a new chunk when the section changes", () => {
    const body = "Sentence about this section. ".repeat(4);
    const chunks = chunkText(`# Doc\n\n## One\n\n${body}\n\n## Two\n\n${body}`);
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].startsWith("# Doc > One\n"));
    assert.ok(chunks[1].startsWith("# Doc > Two\n"));
  });
  test("overlaps whole sentences between consecutive chunks of a section", () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} explains one detail of the topic.`).join(" ");
    const chunks = chunkText(sentences);
    assert.ok(chunks.length > 1);
    const tail = chunks[0].split(" ").slice(-6).join(" ");
    assert.ok(chunks[1].includes(tail), "the second chunk should repeat the tail of the first");
  });
  test("cuts a wall of text with no sentence end on word boundaries", () => {
    const chunks = chunkText(`${"word ".repeat(600)}`);
    assert.ok(chunks.every((c) => c.length <= CHUNK_MAX));
    assert.ok(chunks.every((c) => !c.startsWith(" ") && !c.endsWith(" ")));
  });
  test("keeps the old signature: a single long token is split at the given size", () => {
    assert.deepEqual(chunkText("x".repeat(2000), 500).map((c) => c.length), [500, 500, 500, 500]);
    assert.deepEqual(chunkText("  a \n\n b  ", 2), ["a", "b"]);
    assert.deepEqual(chunkText("   "), []);
  });
  test("never exceeds the ceiling on real documents", () => {
    for (const doc of Object.values(FIXTURES)) {
      assert.ok(chunkText(doc).every((c) => c.length <= CHUNK_MAX), "chunk longer than CHUNK_MAX");
    }
  });
});

// --- Comparison against the chunking this replaced -------------------------------------
// Fixed-size cut of the whitespace-collapsed text: what src/ingest.js did before.
function legacyChunkText(text, size = CHUNK_SIZE) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size) chunks.push(clean.slice(i, i + size));
  return chunks;
}

const FIXTURES = Object.fromEntries(["vectorize", "workflows", "workers-ai"].map((name) => [
  name,
  readFileSync(new URL(`./fixtures/cloudflare-${name}.md`, import.meta.url), "utf8"),
]));

const HEADING_LINE = /^#{1,6}\s+/;
// A heading marker that is not the chunk's own heading line: the chunk carries two sections.
const INNER_HEADING = /(?:^|\s)#{1,6} +(?=[^\s#])/g;

function quality(chunks) {
  let midSentence = 0;
  let midWord = 0;
  let twoSections = 0;
  chunks.forEach((chunk, i) => {
    const text = chunk.trim();
    const lines = text.split("\n");
    const body = HEADING_LINE.test(lines[0]) ? lines.slice(1).join("\n").trim() : text;
    // A chunk that does not start where a sentence, a list item or a block starts continues
    // a sentence that was cut in the previous chunk.
    if (i > 0 && !/^[\p{Lu}\p{N}"'`([*_#|\-+>~]/u.test(body)) midSentence++;
    if (i < chunks.length - 1 && /[\p{L}\p{N}]$/u.test(text) && /^[\p{L}\p{N}]/u.test(chunks[i + 1].trim())) midWord++;
    for (const match of chunk.matchAll(INNER_HEADING)) if (match.index > 0) { twoSections++; break; }
  });
  const chars = chunks.reduce((n, c) => n + c.length, 0);
  return { chunks: chunks.length, avg: Math.round(chars / chunks.length), chars, midSentence, midWord, twoSections };
}

describe("structure-aware vs fixed-size chunking (real documentation pages)", () => {
  const rows = [];
  for (const [name, doc] of Object.entries(FIXTURES)) {
    test(`${name}: fewer broken sentences and no mixed sections`, () => {
      const before = quality(legacyChunkText(doc));
      const after = quality(chunkText(doc));
      rows.push([name, doc.length, before, after]);

      assert.equal(after.midSentence, 0, "no chunk may start in the middle of a sentence");
      assert.equal(after.midWord, 0, "no word may be split across two chunks");
      assert.equal(after.twoSections, 0, "no chunk may mix two headings");
      assert.ok(before.midSentence > 0 && before.midWord > 0 && before.twoSections > 0, "the old chunking should show the defects this fixes");
      // Structure costs some duplication (overlap + heading line) but must stay marginal.
      assert.ok(after.chars < before.chars * 1.25, `indexed characters grew too much: ${before.chars} → ${after.chars}`);
      assert.ok(Math.abs(after.avg - AVG_CHUNK_CHARS) < AVG_CHUNK_CHARS, "average chunk length should stay near the documented one");
    });
  }

  test("summary", () => {
    const total = (i, k) => rows.reduce((n, r) => n + r[i][k], 0);
    const table = rows.map(([name, size, before, after]) =>
      `${name.padEnd(11)} ${String(size).padStart(6)}  chunks ${before.chunks}→${after.chunks}  avg ${before.avg}→${after.avg}` +
      `  mid-sentence ${before.midSentence}→${after.midSentence}  mid-word ${before.midWord}→${after.midWord}  two-sections ${before.twoSections}→${after.twoSections}`);
    console.log(`\n  ${table.join("\n  ")}\n  TOTAL indexed characters ${total(2, "chars")} → ${total(3, "chars")}\n`);
    assert.equal(rows.length, 3);
  });
});
