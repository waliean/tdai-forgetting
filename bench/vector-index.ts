/**
 * Embedding access for the offline benchmark.
 *
 * tdai stores L1 embeddings inside sqlite-vec's `vec0` virtual table. The vec0
 * extension is not available in a plain `node:sqlite` process, so this module
 * reads the shadow tables that vec0 maintains (`<table>_rowids` for the id map,
 * `<table>_vector_chunks00` for the packed float32 payload) and rebuilds a plain
 * cosine index in memory.
 *
 * That is enough for an evaluation harness, and it keeps the benchmark dependency
 * free: no vector extension, no server, no network beyond the embedding provider.
 *
 * Layout assumption, verified against sqlite-vec 0.1.7-alpha.2 on the live tdai
 * database: one row in `*_vector_chunks00` holds `chunk_size` contiguous vectors,
 * and `*_rowids.chunk_offset` indexes into it.
 */

import { DatabaseSync } from "node:sqlite";

export interface VectorIndex {
  dimension: number;
  ids: string[];
  /** Row-major, length = ids.length * dimension. */
  vectors: Float32Array;
  index: Map<string, number>;
}

/**
 * Dimension comes from the vec0 DDL (`embedding float[1024]`), not from a query:
 * reading the virtual table itself needs the vec0 module loaded, which is exactly
 * what this reader is here to avoid.
 */
function chunkLayout(db: DatabaseSync, table: string): { dim: number; bytesPerVector: number } {
  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(table) as { sql?: string } | undefined;
  const dimMatch = /\[\s*(\d+)\s*\]/.exec(ddl?.sql ?? "");
  if (!dimMatch) {
    throw new Error(`cannot determine vector dimension from DDL of ${table}`);
  }
  const dim = Number(dimMatch[1]);
  return { dim, bytesPerVector: dim * 4 };
}

export function loadVectorIndex(dbPath: string, table = "l1_vec"): VectorIndex {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const { dim, bytesPerVector } = chunkLayout(db, table);
    const rowids = db
      .prepare(`SELECT id, chunk_id, chunk_offset FROM "${table}_rowids" ORDER BY chunk_offset ASC`)
      .all() as unknown as Array<{ id: string; chunk_id: number; chunk_offset: number }>;

    if (rowids.length === 0) {
      return { dimension: dim, ids: [], vectors: new Float32Array(0), index: new Map() };
    }

    const chunks = new Map<number, Uint8Array>();
    const chunkRows = db
      .prepare(`SELECT rowid, vectors FROM "${table}_vector_chunks00"`)
      .all() as unknown as Array<{ rowid: number; vectors: Uint8Array }>;
    for (const row of chunkRows) chunks.set(Number(row.rowid), row.vectors);

    const ids: string[] = [];
    const vectors = new Float32Array(rowids.length * dim);

    rowids.forEach((row, i) => {
      const blob = chunks.get(Number(row.chunk_id));
      if (!blob) return;
      const offset = Number(row.chunk_offset) * bytesPerVector;
      if (offset + bytesPerVector > blob.byteLength) return;
      const view = new Float32Array(
        blob.buffer.slice(blob.byteOffset + offset, blob.byteOffset + offset + bytesPerVector),
      );
      vectors.set(view, i * dim);
      ids.push(row.id);
    });

    const index = new Map<string, number>();
    ids.forEach((id, i) => index.set(id, i));

    return { dimension: dim, ids, vectors, index };
  } finally {
    db.close();
  }
}

/** Cosine similarity. Returns 0 for zero vectors, which sqlite-vec reports as NULL distance. */
export function cosine(a: Float32Array, b: Float32Array, dimension: number, aOffset = 0, bOffset = 0): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < dimension; i++) {
    const x = a[aOffset + i];
    const y = b[bOffset + i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Hit {
  id: string;
  score: number;
}

/** Full scan, top-k. Fine for a few thousand rows; this runs offline, not per query. */
export function searchVectors(index: VectorIndex, query: Float32Array, topK: number): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < index.ids.length; i++) {
    const score = cosine(index.vectors, query, index.dimension, i * index.dimension, 0);
    hits.push({ id: index.ids[i], score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/** Call a local Ollama instance for bge-m3 embeddings, matching tdai's default provider. */
export async function embedWithOllama(text: string, baseUrl = "http://127.0.0.1:11434", model = "bge-m3"): Promise<Float32Array> {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`ollama embeddings failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { embedding?: number[] };
  if (!body.embedding) throw new Error("ollama response missing embedding");
  return Float32Array.from(body.embedding);
}
