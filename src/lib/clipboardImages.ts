import { isSafeLocalImageSrc } from "./safeImage";

export const MAX_CAPTURE_IMAGES = 8;
export const MAX_IMAGE_BYTES = 400_000;
const MAX_IMAGE_EDGE = 1280;

export interface CapturedImage {
  id: string;
  name: string;
  mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  dataUrl: string;
}

const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);

export function imageFilesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const fromItems = [...data.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (fromItems.length > 0) return fromItems;
  return [...data.files].filter((file) => file.type.startsWith("image/"));
}

export async function readClipboardImageFiles(): Promise<File[]> {
  if (!navigator.clipboard || !("read" in navigator.clipboard)) return [];
  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      files.push(new File([blob], "clipboard-image", { type: blob.type || type }));
    }
    return files;
  } catch {
    return [];
  }
}

export async function filesToCapturedImages(files: File[], existingCount = 0): Promise<CapturedImage[]> {
  const remaining = Math.max(0, MAX_CAPTURE_IMAGES - existingCount);
  const selected = files.filter((file) => ALLOWED_TYPES.has(file.type.toLowerCase())).slice(0, remaining);
  const captured: CapturedImage[] = [];
  for (const file of selected) {
    captured.push(await compressImageFile(file));
  }
  return captured;
}

export function capturedImageToLlmInput(image: CapturedImage): { mime: CapturedImage["mime"]; dataBase64: string } {
  const comma = image.dataUrl.indexOf(",");
  return {
    mime: image.mime,
    dataBase64: comma >= 0 ? image.dataUrl.slice(comma + 1) : "",
  };
}

async function compressImageFile(file: File): Promise<CapturedImage> {
  const originalUrl = await blobToDataUrl(file);
  const fallbackMime = normalizeMime(file.type);
  const name = file.name?.trim() || "粘贴的图片";
  try {
    if (typeof createImageBitmap !== "function") {
      return capturedFromDataUrl(originalUrl, fallbackMime, name);
    }
    const bitmap = await createImageBitmap(file);
    let edge = MAX_IMAGE_EDGE;
    let quality = 0.72;
    let dataUrl = drawJpeg(bitmap, edge, quality);
    for (let attempt = 0; attempt < 3 && dataUrl.length > MAX_IMAGE_BYTES * 1.37; attempt += 1) {
      edge = Math.max(640, Math.round(edge * 0.75));
      quality = Math.max(0.48, quality - 0.12);
      dataUrl = drawJpeg(bitmap, edge, quality);
    }
    bitmap.close();
    if (!isSafeLocalImageSrc(dataUrl)) {
      return capturedFromDataUrl(originalUrl, fallbackMime, name);
    }
    return { id: crypto.randomUUID(), name, mime: "image/jpeg", dataUrl };
  } catch {
    return capturedFromDataUrl(originalUrl, fallbackMime, name);
  }
}

function capturedFromDataUrl(dataUrl: string, mime: CapturedImage["mime"], name: string): CapturedImage {
  if (!isSafeLocalImageSrc(dataUrl)) {
    throw new Error("不支持的图片格式");
  }
  return { id: crypto.randomUUID(), name, mime, dataUrl };
}

function drawJpeg(bitmap: ImageBitmap, maxEdge: number, quality: number): string {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法压缩图片");
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}

function normalizeMime(value: string): CapturedImage["mime"] {
  const mime = value.trim().toLowerCase();
  if (mime === "image/jpg" || mime === "image/jpeg") return "image/jpeg";
  if (mime === "image/gif") return "image/gif";
  if (mime === "image/webp") return "image/webp";
  return "image/png";
}
