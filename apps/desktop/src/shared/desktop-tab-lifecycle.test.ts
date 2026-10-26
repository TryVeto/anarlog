import { describe, expect, it, vi } from "vitest";

import {
  createDesktopTabCloseHandler,
  initializeDesktopTabs,
} from "./desktop-tab-lifecycle";

import * as sessionQueries from "~/session/queries";
import { createSessionTab } from "~/store/zustand/tabs/test-utils";

describe("desktop tab lifecycle", () => {
  describe("initializeDesktopTabs", () => {
    it("restores pinned tabs and recent notes without opening a startup tab", async () => {
      const tabs = [createSessionTab({ id: "restored-session" })];
      const setRecentlyOpenedSessionIds = vi.fn();
      const restorePinnedTabs = vi.fn().mockResolvedValue(undefined);
      const restoreRecentlyOpenedSessionIds = vi
        .fn()
        .mockImplementation(async (set: (ids: string[]) => void) => {
          set(["restored-session"]);
        });

      await initializeDesktopTabs({
        getTabs: () => tabs,
        setRecentlyOpenedSessionIds,
        restorePinnedTabs,
        restoreRecentlyOpenedSessionIds,
        onZeroTabs: null,
        isTauriEnv: true,
      });

      expect(restorePinnedTabs).toHaveBeenCalledTimes(1);
      expect(setRecentlyOpenedSessionIds).toHaveBeenCalledWith([
        "restored-session",
      ]);
    });

    it("calls onZeroTabs when startup has no restored tabs", async () => {
      const onZeroTabs = vi.fn();

      await initializeDesktopTabs({
        getTabs: () => [],
        setRecentlyOpenedSessionIds: vi.fn(),
        restorePinnedTabs: vi.fn().mockResolvedValue(undefined),
        restoreRecentlyOpenedSessionIds: vi.fn().mockResolvedValue(undefined),
        onZeroTabs,
        isTauriEnv: true,
      });

      expect(onZeroTabs).toHaveBeenCalledTimes(1);
    });

    it("runs startup work even when pinned tabs were restored", async () => {
      const tabs = [createSessionTab({ id: "restored-session" })];
      const onInitialized = vi.fn();
      const onZeroTabs = vi.fn();

      await initializeDesktopTabs({
        getTabs: () => tabs,
        setRecentlyOpenedSessionIds: vi.fn(),
        restorePinnedTabs: vi.fn().mockResolvedValue(undefined),
        restoreRecentlyOpenedSessionIds: vi.fn().mockResolvedValue(undefined),
        onInitialized,
        onZeroTabs,
        isTauriEnv: true,
      });

      expect(onInitialized).toHaveBeenCalledTimes(1);
      expect(onZeroTabs).not.toHaveBeenCalled();
    });
  });

  it("closing a partially synced meeting preserves it for incoming content", async () => {
    const sessions = new Map([["session-1", { body: "", deleted: false }]]);
    vi.spyOn(sessionQueries, "isSessionEmpty").mockResolvedValue(true);
    vi.spyOn(sessionQueries, "softDeleteSession").mockImplementation(
      async (id) => {
        sessions.get(id)!.deleted = true;
        return null;
      },
    );
    createDesktopTabCloseHandler({ purgePreview: vi.fn() })(
      createSessionTab({ id: "session-1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessions.get("session-1")!.body = "Meeting notes received from mobile";
    expect(sessions.get("session-1")).toEqual({
      body: "Meeting notes received from mobile",
      deleted: false,
    });
    vi.restoreAllMocks();
  });

  it("purges ephemeral previews through the central close handler", () => {
    const purgePreview = vi.fn();
    const handler = createDesktopTabCloseHandler({
      purgePreview,
    });

    handler({
      type: "shared_note_preview",
      id: "13697a87-f69b-456d-8679-4202d4f5d498",
      active: true,
      pinned: false,
      slotId: "slot-1",
    });

    expect(purgePreview).toHaveBeenCalledWith(
      "13697a87-f69b-456d-8679-4202d4f5d498",
    );
  });
});
