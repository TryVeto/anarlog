mod common;

use anlg_db_app::{apply_e2ee_replica_changes, encrypt_e2ee_replica_changes, prepare_schema};
use anlg_db_core::Db;
use common::{TestEvent, TestSink, next_event};
use db_reactive::LiveQueryRuntime;
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};

#[tokio::test]
async fn encrypted_replica_delivery_refreshes_open_notes_without_losing_speakers() {
    let source = Db::connect_memory_plain().await.unwrap();
    let target = Db::connect_memory_plain().await.unwrap();
    prepare_schema(&source).await.unwrap();
    prepare_schema(&target).await.unwrap();
    let target_pool = target.pool().clone();
    let runtime = LiveQueryRuntime::new(Arc::new(target));
    let (sink, events) = TestSink::capture();
    let registration = runtime
        .subscribe(
            "SELECT s.title, d.body, t.words_json, t.speaker_hints_json FROM sessions s
         LEFT JOIN session_documents d ON d.id = s.id AND d.deleted_at IS NULL
         LEFT JOIN transcripts t ON t.session_id = s.id AND t.deleted_at IS NULL
         WHERE s.id = 'meeting' AND s.deleted_at IS NULL"
                .into(),
            vec![],
            sink,
        )
        .await
        .unwrap();
    assert_eq!(
        next_event(&events, 0, Duration::from_secs(5))
            .await
            .unwrap(),
        TestEvent::Result(vec![])
    );
    sqlx::query("INSERT INTO sessions (id, workspace_id, title) VALUES ('meeting', 'workspace-a', 'Planning')")
        .execute(source.pool()).await.unwrap();
    let keys = HashMap::from([(
        "workspace-a".into(),
        anlg_e2ee::RecoveryKey::generate()
            .unwrap()
            .workspace_key("workspace-a")
            .unwrap()
            .into(),
    )]);
    // First deliver only the parent: opening a meeting must tolerate a missing document.
    async fn deliver(
        source: &sqlx::SqlitePool,
        target: &sqlx::SqlitePool,
        keys: &HashMap<String, anlg_e2ee::WorkspaceKeyring>,
    ) {
        encrypt_e2ee_replica_changes(source, keys).await.unwrap();
        let records: Vec<(String, String, String)> =
            sqlx::query_as("SELECT id, workspace_id, payload FROM e2ee_records")
                .fetch_all(source)
                .await
                .unwrap();
        for (id, workspace, payload) in records {
            sqlx::query("INSERT INTO e2ee_records (id, workspace_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload")
                .bind(id).bind(workspace).bind(payload).execute(target).await.unwrap();
        }
        for _ in 0..32 {
            if !apply_e2ee_replica_changes(target, keys)
                .await
                .unwrap()
                .remaining_replica_changes
            {
                return;
            }
        }
        panic!("replica did not settle");
    }
    deliver(source.pool(), &target_pool, &keys).await;
    let TestEvent::Result(initial) = next_event(&events, 1, Duration::from_secs(5))
        .await
        .unwrap()
    else {
        panic!("query failed")
    };
    assert_eq!(initial[0]["body"], serde_json::Value::Null);
    let words = json!([{"id":"one","text":"Hello","start_ms":0,"end_ms":100,"channel":2}, {"id":"two","text":"Hi","start_ms":200,"end_ms":300,"channel":2}]).to_string();
    let hints = json!([{"id":"assignment","word_id":"two","type":"user_speaker_assignment","value":{"human_id":"alice","scope":"segment","word_ids":["two"]}}]).to_string();
    sqlx::query("INSERT INTO session_documents (id, workspace_id, session_id, kind, body_format, body) VALUES ('meeting', 'workspace-a', 'meeting', 'note', 'markdown', 'Keep every paragraph')").execute(source.pool()).await.unwrap();
    sqlx::query("INSERT INTO transcripts (id, workspace_id, session_id, words_json, speaker_hints_json) VALUES ('transcript', 'workspace-a', 'meeting', ?, ?)").bind(&words).bind(&hints).execute(source.pool()).await.unwrap();
    deliver(source.pool(), &target_pool, &keys).await;
    let expected = json!({"title":"Planning", "body":"Keep every paragraph", "words_json":words, "speaker_hints_json":hints});
    let mut matched = false;
    for index in 2..10 {
        if let Ok(TestEvent::Result(rows)) =
            next_event(&events, index, Duration::from_secs(5)).await
        {
            if rows == vec![expected.clone()] {
                matched = true;
                break;
            }
        } else {
            break;
        }
    }
    assert!(
        matched,
        "the existing subscription must receive the decrypted note and speaker assignments"
    );
    runtime.unsubscribe(&registration.id).await.unwrap();
}
