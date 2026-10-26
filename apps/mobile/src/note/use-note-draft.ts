import { useRef, useState, useSyncExternalStore } from "react";

import type { RestoredNote } from "@/data/conflicts";
import { saveSessionNote, saveSessionTitle } from "@/data/session";
import type { SessionDetail } from "@/data/session-detail";
import { captureOperationalError } from "@/lib/error-reporting";
import { showToast } from "@/lib/toast";
import { useMountEffect } from "@/lib/use-mount-effect";

import { createNoteDraft } from "./note-draft";

export function useNoteDraft(sessionId: string, data: SessionDetail | null) {
  const dataRef = useRef(data);
  dataRef.current = data;
  const [draft] = useState(() =>
    createNoteDraft({
      getNote: () => dataRef.current,
      saveNote: (note) => saveSessionNote(sessionId, note),
      saveTitle: (title) => saveSessionTitle(sessionId, title),
      onConflict: () =>
        showToast({
          id: `note-conflict-${sessionId}`,
          title: "Note updated on another device",
          description: "Your edits are saved in version history.",
        }),
      onError: (error, patch) => {
        showToast({
          id: `note-save-error-${sessionId}`,
          title: "Couldn’t save note",
          description: "Your latest edits could not be saved.",
        });
        captureOperationalError(error, {
          operation: "session_note_save",
          tags: {
            edit_type: patch.body !== undefined ? "body" : "title",
            ...(patch.body !== undefined && {
              body_format: patch.bodyFormat ?? dataRef.current?.bodyFormat,
            }),
          },
        });
      },
    }),
  );
  useSyncExternalStore(draft.subscribe, draft.revision);
  // Body restores reset the caret; title-only restores leave it in place.
  const [restored, setRestored] = useState<
    (RestoredNote & { titleToken: number; bodyToken: number }) | null
  >(null);
  draft.observeTitle(data?.title);
  useMountEffect(() => () => {
    void draft.flush();
  });

  return {
    ...draft,
    restored,
    bodyDraft: draft.body(),
    onRestored(note: RestoredNote) {
      draft.restore(note.title);
      setRestored((current) => ({
        ...note,
        titleToken: (current?.titleToken ?? 0) + 1,
        bodyToken: (current?.bodyToken ?? 0) + (note.bodyText === null ? 0 : 1),
      }));
    },
  };
}
