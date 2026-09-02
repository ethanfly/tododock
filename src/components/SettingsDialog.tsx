import { useEffect, useId, useLayoutEffect, useRef, type ChangeEvent, type RefObject } from "react";

import type { AppCapabilities, AppSettings } from "../types";
import { shortcutLabel } from "../lib/shortcut";
import { DateTimePicker } from "./DateTimePicker";
import { ShortcutRecorder } from "./ShortcutRecorder";

interface SettingsDialogProps {
  settings: AppSettings;
  settingsDraft: AppSettings;
  capabilities: AppCapabilities | null;
  notificationPermission: boolean | null;
  dataDirectory: string;
  saving: boolean;
  importInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (next: AppSettings) => void;
  onSave: () => void;
  onClose: () => void;
  onEnableNotifications: () => void;
  onPickDataFile: (mode: "import" | "restore") => void;
  onExport: (kind: "export" | "markdown" | "backup") => void;
  onDiagnostics: () => void;
  onPurge: () => void;
  onImportFile: (file: File) => void;
}

const commonReminderMinutes = [0, 5, 15, 60, 1440];
const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
].join(",");

export function SettingsDialog({
  settings,
  settingsDraft,
  capabilities,
  notificationPermission,
  dataDirectory,
  saving,
  importInputRef,
  onDraftChange,
  onSave,
  onClose,
  onEnableNotifications,
  onPickDataFile,
  onExport,
  onDiagnostics,
  onPurge,
  onImportFile,
}: SettingsDialogProps) {
  const dialogTitleId = useId();
  const themeSelectRef = useRef<HTMLSelectElement>(null);

  useLayoutEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    themeSelectRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function onImportChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onImportFile(file);
  }

  return (
    <section
      className="settings-window"
      aria-labelledby={dialogTitleId}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector)];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && last && event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (first && last && !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <h1 id={dialogTitleId} className="sr-only">设置</h1>
      <div className="settings-heading">
          <div>
            <strong>桌面与提醒</strong>
            <p>{capabilities?.reason ?? "当前环境支持核心桌面能力。"}</p>
          </div>
          <div className="shortcut-key">
            {settings.globalShortcutEnabled ? (
              <>
                <kbd>{shortcutLabel(settings.createShortcut)}</kbd>
                <kbd>{shortcutLabel(settings.globalShortcut)}</kbd>
              </>
            ) : (
              <kbd>已关闭</kbd>
            )}
          </div>
        </div>

        <div className="settings-grid">
          <label>
            <span>主题</span>
            <select
              ref={themeSelectRef}
              value={settingsDraft.theme}
              aria-label="主题"
              onChange={(event) => onDraftChange({ ...settingsDraft, theme: event.target.value as AppSettings["theme"] })}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label>
            <span>默认提醒</span>
            <select
              value={settingsDraft.defaultReminderMinutes}
              aria-label="默认提醒"
              onChange={(event) => onDraftChange({ ...settingsDraft, defaultReminderMinutes: Number(event.target.value) })}
            >
              <option value={0}>到期时</option>
              <option value={5}>提前 5 分钟</option>
              <option value={15}>提前 15 分钟</option>
              <option value={60}>提前 1 小时</option>
              <option value={1440}>提前 1 天</option>
              {!commonReminderMinutes.includes(settingsDraft.defaultReminderMinutes) && (
                <option value={settingsDraft.defaultReminderMinutes}>
                  提前 {settingsDraft.defaultReminderMinutes} 分钟
                </option>
              )}
            </select>
          </label>
          <label className="switch-row">
            <span>贴边隐藏</span>
            <input
              type="checkbox"
              checked={settingsDraft.autoHide}
              disabled={!capabilities?.edgeHide}
              onChange={(event) => onDraftChange({ ...settingsDraft, autoHide: event.target.checked })}
            />
          </label>
          <label className="switch-row">
            <span>开机启动</span>
            <input
              type="checkbox"
              checked={settingsDraft.launchAtLogin}
              onChange={(event) => onDraftChange({ ...settingsDraft, launchAtLogin: event.target.checked })}
            />
          </label>
          <label className="switch-row">
            <span>关闭到托盘</span>
            <input
              type="checkbox"
              checked={settingsDraft.closeToTray}
              disabled={!capabilities?.tray}
              onChange={(event) => onDraftChange({ ...settingsDraft, closeToTray: event.target.checked })}
            />
          </label>
          <label className="switch-row">
            <span>静默时段</span>
            <input
              type="checkbox"
              checked={settingsDraft.quietHoursStart !== null}
              onChange={(event) => onDraftChange({
                ...settingsDraft,
                quietHoursStart: event.target.checked ? "22:00" : null,
                quietHoursEnd: event.target.checked ? "08:00" : null,
              })}
            />
          </label>
          {settingsDraft.quietHoursStart !== null && settingsDraft.quietHoursEnd !== null && (
            <label className="quiet-hours-field">
              <span>静默时间</span>
              <span>
                <DateTimePicker
                  mode="time"
                  aria-label="静默开始时间"
                  value={settingsDraft.quietHoursStart}
                  onChange={(value) => onDraftChange({ ...settingsDraft, quietHoursStart: value || "22:00" })}
                />
                <span>至</span>
                <DateTimePicker
                  mode="time"
                  aria-label="静默结束时间"
                  value={settingsDraft.quietHoursEnd}
                  onChange={(value) => onDraftChange({ ...settingsDraft, quietHoursEnd: value || "08:00" })}
                />
              </span>
            </label>
          )}
          <label className="switch-row shortcut-toggle">
            <span>启用全局快捷键</span>
            <input
              type="checkbox"
              checked={settingsDraft.globalShortcutEnabled}
              onChange={(event) => onDraftChange({ ...settingsDraft, globalShortcutEnabled: event.target.checked })}
            />
          </label>
          <div className="notification-permission">
            <span>
              <strong>系统通知</strong>
              <small>
                {capabilities?.notifications === false
                  ? "浏览器预览不提供系统通知"
                  : notificationPermission === true
                    ? "已允许；应用内提醒同时保留"
                    : "未授权时使用应用内提醒兜底"}
              </small>
            </span>
            <button
              type="button"
              className="text-button"
              disabled={capabilities?.notifications === false || notificationPermission === true}
              onClick={onEnableNotifications}
            >
              {capabilities?.notifications === false ? "桌面可用" : notificationPermission === true ? "已启用" : "请求权限"}
            </button>
          </div>
          <label className="shortcut-field">
            <span>新建待办快捷键</span>
            <ShortcutRecorder
              value={settingsDraft.createShortcut}
              disabled={!settingsDraft.globalShortcutEnabled}
              ariaLabel="新建待办快捷键"
              onChange={(createShortcut) => onDraftChange({ ...settingsDraft, createShortcut })}
            />
            <span className="field-hint">默认 Ctrl + Alt + Q；窗口显示时再按会隐藏，隐藏时再按会打开</span>
          </label>
          <label className="shortcut-field">
            <span>待办窗口快捷键</span>
            <ShortcutRecorder
              value={settingsDraft.globalShortcut}
              disabled={!settingsDraft.globalShortcutEnabled}
              ariaLabel="待办窗口快捷键"
              onChange={(globalShortcut) => onDraftChange({ ...settingsDraft, globalShortcut })}
            />
            <span className="field-hint">默认 Alt + Space；窗口显示时再按会隐藏，隐藏时再按会打开</span>
          </label>
        </div>

        <p className="data-directory" title={dataDirectory}>
          本地数据目录：<span>{dataDirectory}</span>
        </p>
        <div className="settings-footer">
          <div className="data-actions">
            <button type="button" className="text-button" onClick={() => onPickDataFile("import")}>导入</button>
            <button type="button" className="text-button" onClick={() => onPickDataFile("restore")}>恢复</button>
            <button type="button" className="text-button" onClick={() => onExport("export")}>JSON</button>
            <button type="button" className="text-button" onClick={() => onExport("markdown")}>Markdown</button>
            <button type="button" className="text-button" onClick={() => onExport("backup")}>备份</button>
            <button type="button" className="text-button" onClick={() => onDiagnostics()}>诊断</button>
            <button type="button" className="text-button danger-text" onClick={onPurge}>清理已删除</button>
          </div>
          <button type="button" className="primary-button compact" onClick={onSave} disabled={saving}>
            {saving ? "保存中…" : "保存设置"}
          </button>
        </div>
        <input
          ref={importInputRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          onChange={onImportChange}
        />
    </section>
  );
}
