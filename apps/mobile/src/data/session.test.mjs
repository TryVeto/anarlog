import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const db = new DatabaseSync(":memory:");
globalThis.noteSyncTest = { db };
const root = new URL("../", import.meta.url);
const stubs = {
  "@/db": `const {db} = globalThis.noteSyncTest;
    export async function execute(sql, params = []) { return db.prepare(sql).all(...params); }
    export async function executeTransaction(statements) {
      db.exec('BEGIN');
      try {
        const result = statements.map(({sql, params}) => db.prepare(sql).run(...params).changes);
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    export function useLiveQuery({sql, params, mapRows}) {
      return {data: mapRows(db.prepare(sql).all(...params)), isLoading: false};
    }`,
  "@/lib/analytics": "export function captureAnalytics() {}",
  "@/lib/ids":
    "export {randomUUID as id} from 'node:crypto'; export const nowIso = () => new Date().toISOString(); export const DEFAULT_USER_ID = 'user';",
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (stubs[specifier])
      return {
        url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`,
        shortCircuit: true,
      };
    if (specifier.startsWith("@/"))
      return {
        url: new URL(`${specifier.slice(2)}.ts`, root).href,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { saveSessionNote, useSessionDetail } = await import("./session.ts");
const { useSessionVersionHistory } = await import("./conflicts.ts");
const { createNoteDraft } = await import("../note/note-draft.ts");
for (const name of [
  "20260710223922_canonical_data_model.sql",
  "20260717120000_e2ee_replica.sql",
  "20260723120000_e2ee_dirty_rows.sql",
  "20260909140000_e2ee_edit_conflicts.sql",
  "20260909150000_session_document_versions.sql",
])
  db.exec(
    readFileSync(
      new URL(`../../../../crates/db-app/migrations/${name}`, import.meta.url),
      "utf8",
    ),
  );
after(() => {
  hooks.deregister();
  db.close();
  delete globalThis.noteSyncTest;
});

test("opening before note sync never saves empty content, and racing edits preserve both versions", async () => {
  db.exec(
    "INSERT INTO sessions (id, title) VALUES ('meeting', 'Weekly planning')",
  );
  let current = useSessionDetail("meeting").data;
  let conflicts = 0;
  let releaseSave;
  let delaySave = false;
  const draft = createNoteDraft({
    getNote: () => current,
    saveNote: async (input) => {
      if (delaySave)
        await new Promise((resolve) => {
          releaseSave = resolve;
        });
      return saveSessionNote("meeting", input);
    },
    saveTitle: async () => {},
    onError: (error) => {
      throw error;
    },
    onConflict: () => {
      conflicts++;
    },
  });
  assert.equal(current.document, null);
  assert.equal(current.plainEditable, false);
  draft.edit({ body: "" });
  await draft.flush(true);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM session_documents").get().count,
    0,
  );

  // The body arrives independently of the meeting, without reopening its screen.
  db.prepare(
    "INSERT INTO session_documents (id, session_id, kind, body_format, body) VALUES ('meeting', 'meeting', 'note', 'markdown', ?)",
  ).run("# Weekly planning\n\nDesktop notes");
  current = useSessionDetail("meeting").data;
  assert.equal(current.noteText, "Desktop notes");
  assert.equal(current.plainEditable, true);
  await draft.flush(true);
  assert.equal(
    db.prepare("SELECT body FROM session_documents").get().body,
    current.document.body,
  );

  // Typing through one autosave keeps the latest edit and advances its baseline,
  // even when the live query still contains the preceding body.
  delaySave = true;
  draft.edit({ body: "First edit", bodyFormat: "markdown" });
  const saving = draft.flush(true);
  draft.edit({ body: "Latest edit", bodyFormat: "markdown" });
  releaseSave();
  await saving;
  delaySave = false;
  await draft.flush(true);
  assert.equal(
    db.prepare("SELECT body FROM session_documents").get().body,
    "# Weekly planning\n\nLatest edit",
  );
  draft.observeBody();
  assert.equal(draft.body().text, "Latest edit");
  current = useSessionDetail("meeting").data;
  draft.observeBody();
  assert.equal(draft.body(), null);
  assert.equal(conflicts, 0);

  draft.edit({ body: "Mobile draft", bodyFormat: "markdown" });
  db.prepare("UPDATE session_documents SET body = ? WHERE id = 'meeting'").run(
    "# Weekly planning\n\nNew desktop content",
  );
  current = useSessionDetail("meeting").data;
  await draft.flush(true);
  assert.equal(conflicts, 1);
  assert.equal(
    db.prepare("SELECT body FROM session_documents").get().body,
    "# Weekly planning\n\nNew desktop content",
  );
  const recovered = useSessionVersionHistory("meeting").data.find(
    (entry) => entry.body === "# Weekly planning\n\nMobile draft",
  );
  assert.ok(recovered?.conflictId);
  assert.equal(recovered.bodyFormat, "markdown");
  assert.equal(draft.body(), null);
  assert.deepEqual(draft.snapshot(), {});

  // A stale autosave must also leave explicit deletion intact.
  draft.edit({ body: "Edit before deletion", bodyFormat: "markdown" });
  db.exec("UPDATE sessions SET deleted_at = 'deleted' WHERE id = 'meeting'");
  await draft.flush(true);
  assert.equal(
    db.prepare("SELECT deleted_at FROM sessions").get().deleted_at,
    "deleted",
  );
  assert.equal(
    db.prepare("SELECT body FROM session_documents").get().body,
    "# Weekly planning\n\nNew desktop content",
  );
  db.exec(
    "INSERT INTO sessions (id, title) VALUES ('offline', ''); INSERT INTO session_documents (id, session_id, kind) VALUES ('offline', 'offline', 'note')",
  );
  const offline = useSessionDetail("offline").data;
  assert.equal(offline.plainEditable, true);
  assert.equal(
    typeof (await saveSessionNote("offline", {
      base: offline.document,
      title: "",
      bodyText: "Written offline",
      bodyFormat: "prosemirror_json",
    })),
    "string",
  );
  assert.equal(useSessionDetail("offline").data.noteText, "Written offline");
});
