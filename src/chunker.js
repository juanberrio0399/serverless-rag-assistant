// Structure-aware chunking for ingestion.
//
// Documents reach us as Markdown (Jina Reader) or as plain text with block newlines
// (the direct-fetch fallback). Cutting that text every N characters splits sentences in
// half and mixes two unrelated sections into one vector, which is exactly what the
// retriever then hands to the LLM. Here the text is first broken into structural units
// (headings, paragraphs, list items, table rows, fenced code, sentences) and those units
// are packed into chunks near the target size, so a chunk never ends mid-sentence, never
// spans two sections, and carries the heading it belongs to.
//
// Everything is deterministic string work: no extra embedding pass, no extra Workers AI
// usage. The only model calls are the ones ingestion already made per chunk.

export const CHUNK_SIZE = 800;      // target characters per chunk
export const CHUNK_MAX = 1000;      // hard ceiling: a chunk is never longer than this
export const CHUNK_MIN = 200;       // below this a chunk is merged into its neighbour (same section)
export const CHUNK_OVERLAP = 120;   // characters of whole-sentence overlap carried into the next chunk
// Chunks end on structural boundaries, so they land below the target. Measured over six real
// Cloudflare documentation pages (three of them in tests/fixtures): 377-586 characters per
// chunk depending on the page, 487 overall. The caps that must cover a document are derived from this number
// rather than from CHUNK_SIZE, which no document ever reaches.
export const AVG_CHUNK_CHARS = 500;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const BULLET = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/;
const FENCE = /^\s{0,3}(```|~~~)/;
const TABLE_ROW = /^\s{0,3}\|/;
// Trailing abbreviation or initial: ". " after these is not the end of a sentence.
const ABBREV = /(?:^|[\s("'[])(?:[A-Za-z]|e\.?g|i\.?e|etc|vs|approx|cf|al|no|fig|eq|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Inc|Ltd|Co|Corp|Ch|p{1,2}|vol|ver|min|max|sec|ref)\.$/i;

// Normalize line endings and whitespace while keeping the block structure (single newline =
// line, blank line = block boundary), which is what the splitter reads.
export function normalizeText(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Split a paragraph into sentences without cutting abbreviations, decimals or URLs.
// A break needs a terminator followed by whitespace and something that starts a sentence.
export function splitSentences(text) {
  const parts = text.split(/(?<=[.!?…])["')\]]*\s+(?=[A-Z0-9"'`([*_#])/u);
  const out = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    // Re-join when the break followed an abbreviation ("e.g. this") or a numbered item ("1. this").
    if (previous !== undefined && (ABBREV.test(previous) || /(?:^|\s)\d{1,3}\.$/.test(previous))) {
      out[out.length - 1] = `${previous} ${part}`;
      continue;
    }
    out.push(part);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

// Break the document into units: the smallest pieces a chunk may be built from. Each unit
// knows the heading path it lives under and whether it may be joined to its neighbour with a
// space (prose) or needs its own line (list item, table row, code).
export function splitUnits(text) {
  const lines = normalizeText(text).split("\n");
  const units = [];
  const path = [];   // [{ level, title }] ancestors of the current section
  let paragraph = [];
  let fence = null;
  let block = [];    // a run of list items / table rows kept on their own lines

  const heading = () => path.map((h) => h.title);
  const pushParagraph = () => {
    if (!paragraph.length) return;
    for (const sentence of splitSentences(paragraph.join(" "))) {
      units.push({ text: sentence, heading: heading(), inline: true });
    }
    paragraph = [];
  };
  const pushBlock = () => {
    for (const line of block) units.push({ text: line, heading: heading(), inline: false });
    block = [];
  };
  const flush = () => { pushParagraph(); pushBlock(); };

  for (const line of lines) {
    if (fence !== null) {
      fence.push(line);
      if (FENCE.test(line)) {
        units.push({ text: fence.join("\n"), heading: heading(), inline: false, atomic: true });
        fence = null;
      }
      continue;
    }
    if (FENCE.test(line)) { flush(); fence = [line]; continue; }

    const head = line.match(HEADING);
    if (head) {
      flush();
      const level = head[1].length;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title: head[2].trim() });
      continue;
    }
    if (line === "") { flush(); continue; }
    if (TABLE_ROW.test(line) || BULLET.test(line)) { pushParagraph(); block.push(line); continue; }
    pushBlock();
    paragraph.push(line);
  }
  if (fence !== null) units.push({ text: fence.join("\n"), heading: heading(), inline: false, atomic: true });
  flush();
  return units;
}

// A unit longer than the ceiling (a wall of text with no sentence end, a long code block)
// is cut on word boundaries as a last resort.
function hardSplit(text, limit) {
  const size = Math.max(limit, 50);
  const pieces = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > size * 0.6 ? cut : size;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

// "# A > B > C": the heading path, carried into every chunk of the section so a retrieved
// fragment says what it is about even when it starts mid-section.
const MAX_HEADING_CHARS = 120;
const headingLine = (heading) => (heading.length ? `# ${heading.join(" > ")}`.slice(0, MAX_HEADING_CHARS) : "");

// The last whole sentences of a chunk, up to `overlap` characters, so the next chunk of the
// same section starts with the context it continues from.
function overlapFrom(units, overlap) {
  const tail = [];
  let size = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    if (unit.atomic || size + unit.text.length > overlap) break;
    tail.unshift(unit);
    size += unit.text.length + 1;
  }
  return tail;
}

// Pack the units of one section into chunks close to the target size.
function packSection(units, { size, max, min, overlap }) {
  const chunks = [];
  const prefix = headingLine(units[0].heading);
  const head = prefix ? `${prefix}\n` : "";
  let current = [];
  let length = 0;

  const flush = () => {
    if (!current.length) return;
    const body = current.reduce((acc, unit, i) => {
      if (i === 0) return unit.text;
      return acc + (unit.inline && current[i - 1].inline ? " " : "\n") + unit.text;
    }, "");
    chunks.push({ text: head + body, units: current });
    current = overlap > 0 ? overlapFrom(current, overlap) : [];
    length = current.reduce((n, u) => n + u.text.length + 1, 0);
  };

  for (const unit of units) {
    const budget = max - head.length;
    if (unit.text.length > budget) {
      flush();
      current = [];
      length = 0;
      for (const piece of hardSplit(unit.text, size - head.length)) {
        chunks.push({ text: head + piece, units: [{ ...unit, text: piece }] });
      }
      continue;
    }
    if (length && length + unit.text.length + 1 > size - head.length) flush();
    current.push(unit);
    length += unit.text.length + 1;
  }
  // The trailing overlap alone is not a chunk: it was already indexed with the previous one.
  if (current.length && !(chunks.length && current.every((u) => chunks[chunks.length - 1].units.includes(u)))) flush();

  // The overlap can leave a chunk whose units all reappear in a neighbour (a short paragraph
  // followed by a long code block). Indexing it twice adds cost and no information.
  for (let i = chunks.length - 1; i >= 0; i--) {
    const inside = (other) => other && chunks[i].units.every((u) => other.units.includes(u));
    if (inside(chunks[i + 1]) || inside(chunks[i - 1])) chunks.splice(i, 1);
  }

  // Fold a stray short chunk into its neighbour rather than indexing a fragment on its own.
  for (let i = chunks.length - 1; i > 0; i--) {
    const merged = `${chunks[i - 1].text}\n${chunks[i].text.slice(head.length)}`;
    if (chunks[i].text.length - head.length < min && merged.length <= max) {
      chunks[i - 1] = { text: merged, units: chunks[i - 1].units.concat(chunks[i].units) };
      chunks.splice(i, 1);
    }
  }
  return chunks.map((c) => c.text);
}

// Split raw text into retrieval-sized chunks that respect the document's structure.
// `size` keeps the old signature (target characters per chunk).
export function chunkText(text, size = CHUNK_SIZE, options = {}) {
  const max = options.max ?? Math.max(size, Math.round(size * (CHUNK_MAX / CHUNK_SIZE)));
  const min = options.min ?? Math.min(Math.round(size * (CHUNK_MIN / CHUNK_SIZE)), size);
  const overlap = options.overlap ?? Math.min(Math.round(size * (CHUNK_OVERLAP / CHUNK_SIZE)), Math.floor(size / 2));
  const units = splitUnits(text);
  const chunks = [];
  let section = [];
  for (const unit of units) {
    const key = unit.heading.join("\u0000");
    if (section.length && section[0].heading.join("\u0000") !== key) {
      chunks.push(...packSection(section, { size, max, min, overlap }));
      section = [];
    }
    section.push(unit);
  }
  if (section.length) chunks.push(...packSection(section, { size, max, min, overlap }));
  return chunks;
}
