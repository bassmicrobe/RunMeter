"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;
const getServerSnapshot = () => "UTC";
const getClientSnapshot = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Keeps the server render deterministic, then switches to the viewer's local
 * time zone immediately after hydration.
 */
export function useLocalTimeZone() {
  return useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  );
}
