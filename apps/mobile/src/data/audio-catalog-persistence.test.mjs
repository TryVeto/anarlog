import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const db = new DatabaseSync(":memory:");
globalThis.audioCatalogPersistence = db;
const mocks = {
  "@/db": `export function useLiveQuery() {} export async function executeTransaction(statements) {
    const db = globalThis.audioCatalogPersistence; db.exec('BEGIN');
    try { const result = statements.map(({sql, params}) => db.prepare(sql).run(...params).changes); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }`,
  "expo-file-system": `export const Paths = {document: '/fixture'}; export const FileMode = {ReadOnly: 0}; export class File {}`,
  "./file-sha256": `export async function hashFileSha256() { return {sha256: 'a'.repeat(64), sizeBytes: 44}; }`,
  "@/attachment-sync/upload-runner": `export function requestMobileAttachmentUploads() {}`,
  "@/attachment-sync/upload-store": `export function requeueMobileAttachmentUpload() {}`,
  "@/lib/ids": `export {randomUUID as id} from 'node:crypto'; export const nowIso = () => new Date().toISOString();`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (mocks[specifier])
      return {
        url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`,
        shortCircuit: true,
      };
    if (specifier === "./audio-catalog-model")
      return {
        url: new URL("./audio-catalog-model.ts", import.meta.url).href,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { recordSessionCaptureStart, catalogSessionAudio } =
  await import("./audio-catalog.ts");
for (const name of [
  "20260710223922_canonical_data_model.sql",
  "20260717140000_attachment_local_state.sql",
  "20260717150000_attachment_transfer_jobs.sql",
  "20260717170000_attachment_cloud_sync_intent.sql",
]) {
  db.exec(
    readFileSync(
      new URL(`../../../../crates/db-app/migrations/${name}`, import.meta.url),
      "utf8",
    ),
  );
}
after(() => {
  hooks.deregister();
  db.close();
  delete globalThis.audioCatalogPersistence;
});

test("recording recovery preserves the durable capture time while imports ignore stale recording metadata", async () => {
  db.exec("INSERT INTO sessions (id) VALUES ('recorded'), ('imported')");
  for (const sessionId of ["recorded", "imported"])
    await recordSessionCaptureStart(sessionId);
  const capture = db
    .prepare(
      "SELECT json_extract(metadata_json, '$.mobile_capture_started_at_ms') AS time FROM sessions WHERE id = 'recorded'",
    )
    .get().time;
  assert.ok(Number.isFinite(capture));
  await catalogSessionAudio("recorded", {
    source: "recording",
    filename: "audio.wav",
    contentType: "audio/wav",
  });
  await catalogSessionAudio("imported", {
    source: "import",
    filename: "audio.wav",
    contentType: "audio/wav",
  });
  const metadata = (sessionId) =>
    JSON.parse(
      db
        .prepare(
          "SELECT metadata_json FROM session_attachments WHERE session_id = ?",
        )
        .get(sessionId).metadata_json,
    );
  assert.equal(metadata("recorded").capture_started_at_ms, capture);
  assert.equal(metadata("imported").capture_started_at_ms, null);
  // Recovery re-catalogs from durable session state without starting a new capture.
  await catalogSessionAudio("recorded", {
    source: "recording",
    filename: "audio.wav",
    contentType: "audio/wav",
  });
  assert.equal(metadata("recorded").capture_started_at_ms, capture);
});
