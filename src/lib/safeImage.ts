const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/]+=*$/i;

export function isSafeLocalImageSrc(value: string): boolean {
  const compact = value.trim().replaceAll(/\s+/g, "");
  return compact.length > 0 && compact.length <= 1_400_000 && SAFE_DATA_IMAGE.test(compact);
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
