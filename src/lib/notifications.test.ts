import { beforeEach, describe, expect, it, vi } from "vitest";

const isPermissionGranted = vi.fn();
const requestPermission = vi.fn();
const isDesktopRuntime = vi.fn();

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted,
  requestPermission,
}));

vi.mock("./api", () => ({
  isDesktopRuntime,
}));

let ensureNotificationPermission: typeof import("./notifications").ensureNotificationPermission;
let notificationPermissionGranted: typeof import("./notifications").notificationPermissionGranted;
let requestNotificationPermission: typeof import("./notifications").requestNotificationPermission;

describe("notification permission helpers", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    isDesktopRuntime.mockReturnValue(true);
    isPermissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue("denied");
    vi.resetModules();
    ({
      ensureNotificationPermission,
      notificationPermissionGranted,
      requestNotificationPermission,
    } = await import("./notifications"));
  });

  it("only asks automatically once after a denial", async () => {
    expect(await ensureNotificationPermission()).toBe(false);
    expect(await ensureNotificationPermission()).toBe(false);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("allows an explicit settings retry", async () => {
    await ensureNotificationPermission();
    expect(await requestNotificationPermission()).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  it("does not touch desktop permission APIs in the browser", async () => {
    isDesktopRuntime.mockReturnValue(false);
    expect(await ensureNotificationPermission()).toBe(false);
    expect(await requestNotificationPermission()).toBe(false);
    expect(await notificationPermissionGranted()).toBeNull();
    expect(isPermissionGranted).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
