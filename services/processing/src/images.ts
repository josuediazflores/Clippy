export type ImageCheck =
  | {
      ok: true;
      mediaType: "image/png" | "image/jpeg";
      width: number;
      height: number;
    }
  | {
      ok: false;
      reason: "unsupported" | "too_large" | "low_quality" | "missing_media";
    };

function pngSize(bytes: Uint8Array): [number, number] | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b))
    return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}
function jpegSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const sof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return [width, height];
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Cheap deterministic screening before any model call. A declared content type is not
 * proof of content: the bytes must parse as that format.
 */
export function inspectImage(
  bytes: Uint8Array | undefined,
  declared: string,
  limits: { maxBytes: number; minDimension: number },
): ImageCheck {
  if (!bytes || bytes.length === 0)
    return { ok: false, reason: "missing_media" };
  if (bytes.length > limits.maxBytes) return { ok: false, reason: "too_large" };
  const size =
    declared === "image/png"
      ? pngSize(bytes)
      : declared === "image/jpeg"
        ? jpegSize(bytes)
        : null;
  if (!size || size[0] === 0 || size[1] === 0)
    return { ok: false, reason: "unsupported" };
  if (Math.min(...size) < limits.minDimension)
    return { ok: false, reason: "low_quality" };
  return {
    ok: true,
    mediaType: declared as "image/png" | "image/jpeg",
    width: size[0],
    height: size[1],
  };
}
