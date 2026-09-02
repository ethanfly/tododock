import type { AppSettings } from "../types";

export function isLoopbackLlmEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint.trim());
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function isLlmConfigured(settings: Pick<AppSettings, "llmEndpoint" | "llmApiKey">): boolean {
  const endpoint = settings.llmEndpoint.trim();
  if (!endpoint) return false;
  if (settings.llmApiKey.trim()) return true;
  return isLoopbackLlmEndpoint(endpoint);
}
