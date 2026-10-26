import type { NoteDocument, SessionDetail } from "../data/session-detail.ts";

export type NoteDraft = {
  title?: string;
  body?: string;
  bodyFormat?: SessionDetail["bodyFormat"];
};

export function createNoteDraft({
  getNote,
  saveNote,
  saveTitle,
  onError,
  onConflict,
}: {
  getNote: () => SessionDetail | null;
  saveNote: (note: {
    base: NoteDocument;
    baseTitle: string;
    title: string;
    bodyText: string;
    bodyFormat: SessionDetail["bodyFormat"];
  }) => Promise<string | null>;
  saveTitle: (title: string) => Promise<void>;
  onError: (error: unknown, draft: NoteDraft) => void;
  onConflict?: () => void;
}) {
  let pending: NoteDraft = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedTitle: string | null = null;
  let inFlight: Promise<string | null | void> | undefined;
  let generation = 0;
  let bodyDraft: {
    text: string;
    format: SessionDetail["bodyFormat"];
    base: NoteDocument;
  } | null = null;
  let savedBody: string | undefined;
  // Live queries may deliver earlier autosave echoes after a later save finishes.
  const previousBodies = new Set<string>();
  let revision = 0;
  const listeners = new Set<() => void>();
  function notify() {
    revision++;
    listeners.forEach((listener) => listener());
  }
  function hasObservedBody() {
    const document = getNote()?.document;
    return (
      !inFlight &&
      pending.body === undefined &&
      savedBody !== undefined &&
      document &&
      (document.body === savedBody || !previousBodies.has(document.body))
    );
  }
  function observeBody() {
    if (hasObservedBody()) {
      bodyDraft = null;
      savedBody = undefined;
      previousBodies.clear();
      notify();
    }
  }

  function cancelTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  function scheduleSave() {
    cancelTimer();
    timer = setTimeout(flush, 500);
  }

  async function waitForSave(throwOnError = false) {
    while (inFlight) {
      try {
        await inFlight;
      } catch (error) {
        if (throwOnError) throw error;
      }
    }
  }

  function discard() {
    generation++;
    cancelTimer();
    pending = {};
    bodyDraft = null;
    savedBody = undefined;
    previousBodies.clear();
    notify();
  }

  async function flush(throwOnError = false) {
    cancelTimer();
    if (inFlight) await waitForSave(throwOnError);
    const note = getNote();
    if (!note) return;
    const draft = pending;
    pending = {};
    const currentGeneration = generation;
    let write: Promise<string | null | void>;
    const bodyFormat = draft.bodyFormat ?? bodyDraft?.format ?? note.bodyFormat;
    if (draft.body !== undefined && bodyDraft) {
      // Live-query results can lag our writes; a body save must keep the latest title.
      const title = draft.title ?? savedTitle ?? note.title;
      savedTitle = title;
      write = saveNote({
        base: bodyDraft.base,
        baseTitle: draft.title !== undefined ? note.title : title,
        title,
        bodyText: draft.body,
        bodyFormat,
      });
    } else if (draft.title !== undefined) {
      savedTitle = draft.title;
      write = saveTitle(draft.title);
    } else {
      return;
    }
    inFlight = write;
    try {
      const body = await write;
      if (
        generation === currentGeneration &&
        draft.body !== undefined &&
        bodyDraft
      ) {
        if (body === null) {
          onConflict?.();
          if (pending.body === undefined) bodyDraft = null;
          savedBody = undefined;
          previousBodies.clear();
          savedTitle = null;
        } else if (typeof body === "string") {
          previousBodies.add(bodyDraft.base.body);
          bodyDraft.base = { ...bodyDraft.base, body, bodyFormat };
          savedBody = body;
        }
      }
    } catch (error) {
      if (generation === currentGeneration) {
        pending = { ...draft, ...pending };
        onError(error, draft);
      }
      if (throwOnError) throw error;
    } finally {
      if (inFlight === write) inFlight = undefined;
      observeBody();
      notify();
    }
  }

  return {
    edit(patch: NoteDraft) {
      observeBody();
      if (patch.body !== undefined) {
        const note = getNote();
        if (!note?.document || !note.plainEditable) return;
        bodyDraft = {
          text: patch.body,
          format: patch.bodyFormat ?? bodyDraft?.format ?? note.bodyFormat,
          base: bodyDraft?.base ?? note.document,
        };
      }
      pending = { ...pending, ...patch };
      scheduleSave();
      notify();
    },
    flush,
    discard,
    async remove(deleteNote: () => Promise<void>) {
      cancelTimer();
      await waitForSave();
      try {
        await deleteNote();
      } catch (error) {
        if (Object.keys(pending).length) scheduleSave();
        throw error;
      }
      discard();
    },
    restore(title: string) {
      generation++;
      cancelTimer();
      pending = {};
      savedTitle = title;
      bodyDraft = null;
      savedBody = undefined;
      previousBodies.clear();
      notify();
    },
    observeTitle(title: string | undefined) {
      if (title === savedTitle) savedTitle = null;
    },
    observeBody,
    body: () => (hasObservedBody() ? null : bodyDraft),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revision: () => revision,
    snapshot: () => ({ ...pending }),
  };
}
