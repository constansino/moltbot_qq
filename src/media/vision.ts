import { promises as fs } from "node:fs";
import path from "node:path";

export const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VISION_IMAGE_COUNT = 3;
export const VISION_IMAGE_TIMEOUT_MS = 15_000;

const QQ_TMP_PREFIX = "qq_vision_";

function extFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/bmp") return ".bmp";
  return null;
}

function extFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function readResponseBodyWithLimit(res: Response, maxBytes: number, controller?: AbortController): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > maxBytes) {
        controller?.abort();
        return null;
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received);
  } finally {
    reader.releaseLock();
  }
}

async function writeTempImageFile(buffer: Buffer, messageId: string | number, index: number, extHint: string): Promise<string> {
  const safeExt = extHint.startsWith(".") ? extHint : ".jpg";
  const name = `${QQ_TMP_PREFIX}${messageId}_${Date.now()}_${index}${safeExt}`;
  const outPath = path.join("/tmp", name);
  await fs.writeFile(outPath, buffer);
  return outPath;
}

export async function materializeImageForVision(rawUrl: string, messageId: string | number, index: number): Promise<string | null> {
  if (!rawUrl) return null;

  try {
    if (rawUrl.startsWith("base64://")) {
      const encoded = rawUrl.slice("base64://".length);
      if (!encoded) return null;
      const buffer = Buffer.from(encoded, "base64");
      if (!buffer.length || buffer.length > MAX_VISION_IMAGE_BYTES) return null;
      return await writeTempImageFile(buffer, messageId, index, ".jpg");
    }

    if (rawUrl.startsWith("file://")) {
      const localPath = decodeURIComponent(rawUrl.slice("file://".length));
      if (!localPath) return null;
      const stat = await fs.stat(localPath).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_VISION_IMAGE_BYTES) return null;
      return localPath;
    }

    if (rawUrl.startsWith("/")) {
      const stat = await fs.stat(rawUrl).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_VISION_IMAGE_BYTES) return null;
      return rawUrl;
    }

    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) return null;

    const headController = new AbortController();
    const headTimeout = setTimeout(() => headController.abort(), VISION_IMAGE_TIMEOUT_MS);
    try {
      const headRes = await fetch(rawUrl, { method: "HEAD", signal: headController.signal });
      if (headRes.ok) {
        const len = parseContentLength(headRes.headers);
        if (len !== null && len > MAX_VISION_IMAGE_BYTES) return null;
      }
    } catch {
      // Some hosts block HEAD requests; enforce size again during GET.
    } finally {
      clearTimeout(headTimeout);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VISION_IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(rawUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (OpenClaw QQ)",
        },
      });
      if (!res.ok) return null;

      const len = parseContentLength(res.headers);
      if (len !== null && len > MAX_VISION_IMAGE_BYTES) return null;

      const body = await readResponseBodyWithLimit(res, MAX_VISION_IMAGE_BYTES, controller);
      if (!body || !body.length) return null;

      const ext = extFromContentType(res.headers.get("content-type")) || extFromUrl(rawUrl) || ".jpg";
      return await writeTempImageFile(body, messageId, index, ext);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn(`[QQ] Failed to prepare image for vision: ${String(error)}`);
    return null;
  }
}

export async function downloadImageUrlAsBase64(rawUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_IMAGE_TIMEOUT_MS);

  try {
    const res = await fetch(rawUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (OpenClaw QQ)",
      },
    });

    if (!res.ok) return null;

    const len = parseContentLength(res.headers);
    if (len !== null && len > MAX_VISION_IMAGE_BYTES) return null;

    const body = await readResponseBodyWithLimit(res, MAX_VISION_IMAGE_BYTES, controller);
    if (!body || !body.length) return null;

    return `base64://${body.toString("base64")}`;
  } catch (error) {
    console.warn(`[QQ] Failed to download external image as base64: ${String(error)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
