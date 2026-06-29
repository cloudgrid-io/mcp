// BM25 keyword search over the CloudGrid documentation corpus.
//
// Chunks markdown files by heading, builds an inverted index, and ranks by
// BM25. The DocsSearch class exposes a clean .search(query) → results interface
// so the backend can be swapped to semantic/embedding search later without
// changing the tool contract.

import { readFileSync, readdirSync } from "node:fs";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "this", "that", "not", "if", "do", "so", "no", "can", "will", "all",
  "has", "had", "have", "each", "which", "their", "you", "your", "its",
  "any", "more", "also", "than", "then", "what", "when", "how", "who",
  "up", "out", "about", "into", "over", "just", "some", "only",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function termFrequency(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

/** Trim a markdown body to a readable snippet. */
function makeSnippet(body, maxLen = 300) {
  const clean = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen - 1) + "\u2026";
}

/** Split a markdown document into chunks by headings (# or ##). */
function chunkMarkdown(source, content) {
  const lines = content.split("\n");
  const chunks = [];
  let title = source;
  let body = [];
  let inFrontmatter = false;
  let seenFirstLine = false;

  for (const line of lines) {
    // Skip YAML frontmatter (--- delimited block at the top).
    if (line.trim() === "---" && !seenFirstLine) {
      inFrontmatter = true;
      seenFirstLine = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") inFrontmatter = false;
      continue;
    }
    seenFirstLine = true;

    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      if (body.length > 0) {
        const text = body.join("\n").trim();
        if (text) chunks.push({ title, body: text, source });
      }
      body = [];
      title = heading[2].trim();
    } else {
      body.push(line);
    }
  }
  const text = body.join("\n").trim();
  if (text) chunks.push({ title, body: text, source });

  return chunks;
}

export class DocsSearch {
  constructor() {
    /** @type {Array<{title: string, body: string, source: string, tokens: string[], tf: Record<string,number>}>} */
    this.docs = [];
    this.df = Object.create(null);
    this.avgdl = 0;
    this._built = false;
  }

  get size() {
    return this.docs.length;
  }

  /** Add a single document chunk to the index. */
  addDocument(title, body, source) {
    // Weight the title 2x by repeating it in the token stream.
    const tokens = tokenize(title + " " + title + " " + body);
    this.docs.push({ title, body, source, tokens, tf: termFrequency(tokens) });
  }

  /** Compute document frequencies and average document length. Call after all adds. */
  build() {
    const N = this.docs.length;
    if (N === 0) return;
    this.avgdl = this.docs.reduce((sum, d) => sum + d.tokens.length, 0) / N;
    this.df = Object.create(null);
    for (const doc of this.docs) {
      const seen = new Set(doc.tokens);
      for (const t of seen) this.df[t] = (this.df[t] || 0) + 1;
    }
    this._built = true;
  }

  /**
   * Search the corpus. Returns the top-K results ranked by BM25.
   * @param {string} query
   * @param {number} topK
   * @returns {Array<{title: string, snippet: string, source: string, score: number}>}
   */
  search(query, topK = 5) {
    if (!this._built) this.build();
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];

    const N = this.docs.length;
    const k1 = 1.5;
    const b = 0.75;

    const scored = this.docs.map((doc) => {
      let score = 0;
      for (const qt of qTokens) {
        const tf = doc.tf[qt] || 0;
        const df = this.df[qt] || 0;
        if (df === 0 || tf === 0) continue;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        score +=
          idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.tokens.length) / this.avgdl)));
      }
      return { doc, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ doc, score }) => ({
        title: doc.title,
        snippet: makeSnippet(doc.body),
        source: doc.source,
        score: Math.round(score * 100) / 100,
      }));
  }
}

/**
 * Load all .md files from src/corpus/, chunk by heading, and build the index.
 * @param {DocsSearch} searchIndex
 * @returns {DocsSearch}
 */
export function loadCorpus(searchIndex) {
  const corpusDir = new URL("./corpus/", import.meta.url);
  const files = readdirSync(corpusDir).filter((f) => f.endsWith(".md")).sort();

  for (const file of files) {
    const content = readFileSync(new URL(file, corpusDir), "utf-8");
    const source = file.replace(/\.md$/, "");
    for (const chunk of chunkMarkdown(source, content)) {
      searchIndex.addDocument(chunk.title, chunk.body, chunk.source);
    }
  }

  searchIndex.build();
  return searchIndex;
}
