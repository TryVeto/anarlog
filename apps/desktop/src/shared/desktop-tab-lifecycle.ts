import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";

import { purgeSharedNotePreview } from "~/shared-notes/preview";
import {
  restorePinnedTabsToStore,
  restoreRecentlyOpenedToStore,
  type Tab,
  useTabs,
} from "~/store/zustand/tabs";

type InitializeDesktopTabsOptions = {
  getTabs: () => Tab[];
  setRecentlyOpenedSessionIds: (ids: string[]) => void;
  restorePinnedTabs: () => Promise<void>;
  restoreRecentlyOpenedSessionIds: (
    set: (ids: string[]) => void,
  ) => Promise<void>;
  onInitialized?: (() => void) | null;
  onZeroTabs?: (() => void) | null;
  isTauriEnv?: boolean;
};

export async function initializeDesktopTabs({
  getTabs,
  setRecentlyOpenedSessionIds,
  restorePinnedTabs,
  restoreRecentlyOpenedSessionIds,
  onInitialized,
  onZeroTabs,
  isTauriEnv = isTauri(),
}: InitializeDesktopTabsOptions) {
  if (!isTauriEnv) {
    onZeroTabs?.();
    return;
  }

  await restorePinnedTabs();
  await restoreRecentlyOpenedSessionIds(setRecentlyOpenedSessionIds);
  onInitialized?.();

  if (getTabs().length > 0) {
    return;
  }

  onZeroTabs?.();
}

export function createDesktopTabCloseHandler({
  purgePreview = purgeSharedNotePreview,
}: {
  purgePreview?: (viewId: string) => void;
} = {}) {
  return (tab: Tab) => {
    // A locally empty meeting may still be receiving content from another device.
    // Closing its tab must never mutate the persisted meeting.
    if (tab.type === "shared_note_preview") purgePreview(tab.id);
  };
}

export function useDesktopTabLifecycle({
  onEmpty,
  onInitialized,
  onZeroTabs,
}: {
  onEmpty?: (() => void) | null;
  onInitialized?: (() => void) | null;
  onZeroTabs?: (() => void) | null;
}) {
  const { registerOnEmpty, registerCanClose, registerOnClose, openNew, pin } =
    useTabs();
  const hasOpenedInitialTab = useRef(false);

  useEffect(() => {
    if (hasOpenedInitialTab.current) {
      return;
    }

    hasOpenedInitialTab.current = true;

    void initializeDesktopTabs({
      getTabs: () => useTabs.getState().tabs,
      setRecentlyOpenedSessionIds: (ids) => {
        useTabs.setState({ recentlyOpenedSessionIds: ids });
      },
      restorePinnedTabs: () =>
        restorePinnedTabsToStore(openNew, pin, () => useTabs.getState().tabs),
      restoreRecentlyOpenedSessionIds: restoreRecentlyOpenedToStore,
      onInitialized,
      onZeroTabs,
    });
  }, [onInitialized, openNew, pin, onZeroTabs]);

  useEffect(() => {
    registerOnEmpty(onEmpty ?? null);
  }, [onEmpty, registerOnEmpty]);

  useEffect(() => {
    registerCanClose(() => true);
  }, [registerCanClose]);

  useEffect(() => {
    registerOnClose(createDesktopTabCloseHandler());
  }, [registerOnClose]);
}
