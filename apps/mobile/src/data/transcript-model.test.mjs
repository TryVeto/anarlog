import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  SESSION_SPEAKERS_SQL,
  SESSION_TRANSCRIPTS_SQL,
  sharedMicrophoneContextStatement,
} from "./transcript-model.ts";

test("historical speaker labels survive contact deletion within their workspace", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE sessions (id TEXT, workspace_id TEXT);
      CREATE TABLE humans (id TEXT, workspace_id TEXT, name TEXT, deleted_at TEXT);
      INSERT INTO sessions VALUES ('session', 'workspace');
      INSERT INTO humans VALUES ('artem', 'workspace', 'Artem', '2026-09-24'),
        ('other', 'other-workspace', 'Other', NULL);`);
    const names = new Map(
      db
        .prepare(SESSION_SPEAKERS_SQL)
        .all("session")
        .map(({ id, name }) => [id, name]),
    );
    assert.deepEqual([...names], [["artem", "Artem"]]);
  } finally {
    db.close();
  }
});

test("mobile capture context survives reload without overwriting desktop intervals", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const desktop = { start_ms: 1, end_ms: 100, shared_microphone: false };
    db.exec(`CREATE TABLE sessions (id TEXT, metadata_json TEXT, updated_at TEXT, deleted_at TEXT);
      CREATE TABLE transcripts (source TEXT, provider TEXT, id TEXT, session_id TEXT, started_at_ms INTEGER, owner_user_id TEXT,
        words_json TEXT, speaker_hints_json TEXT, deleted_at TEXT, created_at TEXT);
      CREATE TABLE transcript_live_deltas (transcript_id TEXT, sequence INTEGER, delta_json TEXT);
      INSERT INTO transcripts (id, session_id, started_at_ms, owner_user_id, words_json, speaker_hints_json, deleted_at, created_at) VALUES ('transcript', 'session', 1000, 'john', '[]', '[]', NULL, 'now');`);
    db.prepare("INSERT INTO sessions VALUES (?, ?, '', NULL)").run(
      "session",
      JSON.stringify({
        other: "retained",
        speaker_context: { intervals: [desktop] },
      }),
    );
    const statement = sharedMicrophoneContextStatement(
      "session",
      1000,
      2500,
      "now",
    );
    db.prepare(statement.sql).run(...statement.params);
    const row = db.prepare(SESSION_TRANSCRIPTS_SQL).get("session");
    assert.equal(row.owner_user_id, "john");
    const context = JSON.parse(row.speaker_context_json);
    assert.deepEqual(context.intervals[0], desktop);
    assert.deepEqual(context.intervals[1], {
      start_ms: 1000,
      end_ms: 3500,
      shared_microphone: true,
      mic_isolated: null,
      active_call: false,
      calendar_call: false,
      title: "",
      self_names: [],
      participants: [],
    });
    assert.equal(
      JSON.parse(
        db.prepare("SELECT metadata_json FROM sessions").get().metadata_json,
      ).other,
      "retained",
    );
  } finally {
    db.close();
  }
});
