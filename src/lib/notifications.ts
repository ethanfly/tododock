import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

import { isDesktopRuntime } from "./api";

let automaticRequestAttempted = false;

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  if (await isPermissionGranted()) return true;
  if (automaticRequestAttempted) return false;
  automaticRequestAttempted = true;
  return (await requestPermission()) === "granted";
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  if (await isPermissionGranted()) return true;
  automaticRequestAttempted = true;
  return (await requestPermission()) === "granted";
}

export async function notificationPermissionGranted(): Promise<boolean | null> {
  if (!isDesktopRuntime()) return null;
  return isPermissionGranted();
}
