import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { IconButton } from "./components/IconButton";
import { SettingsDialog } from "./components/SettingsDialog";
import { WindowChrome } from "./components/WindowChrome";
import {
  backupData,
  closeAuxiliaryWindow,
  defaultAppSettings,
  exportData,
  exportDiagnostics,
  exportMarkdown,
  getCapabilities,
  getDataDirectory,
  getSettings,
  importData,
  notifySettingsChanged,
  previewImport,
  previewRestore,
  purgeDeletedTodos,
  restoreData,
  saveSettings,
} from "./lib/api";
import { notificationPermissionGranted, requestNotificationPermission } from "./lib/notifications";
import type { AppCapabilities, AppSettings } from "./types";

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

export function SettingsApp() {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(defaultAppSettings);
  const [capabilities, setCapabilities] = useState<AppCapabilities | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<boolean | null>(null);
  const [dataDirectory, setDataDirectory] = useState("正在读取…");
  const [saving, setSaving] = useState(false);
  const [dataFileMode, setDataFileMode] = useState<"import" | "restore">("import");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void getCapabilities().then(setCapabilities).catch(() => undefined);
    void getDataDirectory().then(setDataDirectory).catch(() => setDataDirectory("无法读取数据目录"));
    void getSettings()
      .then((value) => {
        setSettings(value);
        setSettingsDraft(value);
        document.documentElement.dataset.theme = value.theme;
      })
      .catch(() => undefined);
    void notificationPermissionGranted().then(setNotificationPermission).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settingsDraft.theme;
  }, [settingsDraft.theme]);

  async function persist() {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await saveSettings(settingsDraft);
      setSettings(saved);
      setSettingsDraft(saved);
      setCapabilities(await getCapabilities());
      await notifySettingsChanged();
      setError(null);
      setNotice("设置已保存");
    } catch (cause) {
      setError(errorMessage(cause, "无法保存设置"));
    } finally {
      setSaving(false);
    }
  }

  async function enableSystemNotifications() {
    try {
      const granted = await requestNotificationPermission();
      setNotificationPermission(granted);
      if (granted) {
        setNotice("系统通知已启用，应用内提醒仍会作为补充。");
        setError(null);
      } else {
        setError("系统通知仍未授权；请在系统设置的“通知 → TodoDock”中允许。应用内提醒会继续工作。");
      }
    } catch (cause) {
      setError(errorMessage(cause, "无法请求系统通知权限"));
    }
  }

  async function writeLocalDataFile(kind: "export" | "markdown" | "backup") {
    try {
      const result = kind === "export"
        ? await exportData()
        : kind === "markdown"
          ? await exportMarkdown()
          : await backupData();
      const label = kind === "export" ? "JSON 导出" : kind === "markdown" ? "Markdown 导出" : "备份";
      setNotice(`${label}完成：${result.todoCount} 项，文件位于 ${result.path}`);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, "无法写入本地数据文件"));
    }
  }

  async function writeDiagnosticFile() {
    try {
      const path = await exportDiagnostics();
      setNotice(`脱敏诊断文件已生成：${path}`);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, "无法生成脱敏诊断文件"));
    }
  }

  async function cleanDeletedTodos() {
    if (!window.confirm("永久清理所有已删除 Todo？此操作不可撤销，建议先创建备份。")) return;
    try {
      const count = await purgeDeletedTodos();
      setNotice(count === 0 ? "没有需要清理的已删除 Todo。" : `已永久清理 ${count} 项 Todo。`);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, "无法清理已删除 Todo"));
    }
  }

  async function handleImportFile(file: File) {
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("导入文件不能超过 20MB");
      const json = await file.text();
      let resultMessage: string;
      if (dataFileMode === "restore") {
        const preview = await previewRestore(json);
        const confirmed = window.confirm(
          `准备从备份恢复 ${preview.total} 项 Todo：新增 ${preview.addCount} 项、替换 ${preview.replaceCount} 项，并从当前列表移除 ${preview.removeCount} 项。恢复前会自动备份当前数据，是否继续？`,
        );
        if (!confirmed) return;
        const result = await restoreData(json);
        resultMessage = `恢复完成：当前共有 ${result.total} 项，移除了 ${result.removeCount} 项原有 Todo。`;
      } else {
        const preview = await previewImport(json);
        const confirmed = window.confirm(
          `准备合并导入 ${preview.total} 项 Todo：新增 ${preview.newCount} 项，更新 ${preview.updateCount} 项。应用设置不会改变；导入前会自动备份现有数据，是否继续？`,
        );
        if (!confirmed) return;
        const result = await importData(json);
        resultMessage = `导入完成：新增 ${result.newCount} 项，更新 ${result.updateCount} 项。`;
      }
      const importedSettings = await getSettings();
      setSettings(importedSettings);
      setSettingsDraft(importedSettings);
      setCapabilities(await getCapabilities());
      await notifySettingsChanged();
      setNotice(resultMessage);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, "导入失败"));
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  return (
    <WindowChrome title="设置" closeLabel="关闭设置" onClose={() => void closeAuxiliaryWindow()}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <IconButton label="关闭错误信息" onClick={() => setError(null)}><X size={14} /></IconButton>
        </div>
      )}
      {notice && (
        <div className="notice-banner" role="status">
          <span>{notice}</span>
          <IconButton label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></IconButton>
        </div>
      )}
      <SettingsDialog
        settings={settings}
        settingsDraft={settingsDraft}
        capabilities={capabilities}
        notificationPermission={notificationPermission}
        dataDirectory={dataDirectory}
        saving={saving}
        importInputRef={importInputRef}
        onDraftChange={setSettingsDraft}
        onSave={() => void persist()}
        onClose={() => void closeAuxiliaryWindow()}
        onEnableNotifications={() => void enableSystemNotifications()}
        onPickDataFile={(mode) => {
          setDataFileMode(mode);
          importInputRef.current?.click();
        }}
        onExport={(kind) => void writeLocalDataFile(kind)}
        onDiagnostics={() => void writeDiagnosticFile()}
        onPurge={() => void cleanDeletedTodos()}
        onImportFile={(file) => void handleImportFile(file)}
      />
    </WindowChrome>
  );
}
