import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Capture, Manifest, CalendarBundle, Transition } from "./Wire";

export const root = path.resolve(__dirname, "../../..");
const schema = JSON.parse(
  fs.readFileSync(path.join(root, "contracts/schema.json"), "utf8"),
);
export const transitions: Record<string, Record<string, string[]>> = JSON.parse(
  fs.readFileSync(path.join(root, "contracts/transitions.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schema);
export const sha256 = (bytes: string | Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(record[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
export const digest = (value: unknown): string => sha256(canonical(value));
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function validate(kind: string, value: unknown): void {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${kind}`);
  requireValue(check?.(value), `Invalid ${kind}`);
  if (kind === "Capture" || kind === "ManifestEntry") {
    const c = value as Capture;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: c.timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(new Date(c.capturedAt));
    const offset = parts.find((p) => p.type === "timeZoneName")!.value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset);
    const seconds = match
      ? (Number(match[2]) * 3600 + Number(match[3]) * 60) *
        (match[1] === "-" ? -1 : 1)
      : 0;
    requireValue(seconds === c.utcOffsetSeconds, "Offset mismatch");
  }
  if (kind === "Manifest") {
    const m = value as Manifest;
    requireValue(m.captures.length === m.captureCount, "Count mismatch");
    requireValue(
      new Set(m.captures.map((c) => c.captureId)).size === m.captureCount,
      "Duplicate capture",
    );
    requireValue(
      new Set(m.captures.map((c) => c.uploadId)).size === m.captureCount,
      "Duplicate upload",
    );
    requireValue(
      m.sequenceEnd >= m.sequenceStart &&
        m.sequenceEnd - m.sequenceStart < 10000,
      "Range",
    );
    requireValue(m.startedAt <= m.cutoffAt, "Cutoff");
    const seen = new Set<number>();
    for (const c of m.captures) {
      validate("ManifestEntry", c);
      requireValue(
        c.deviceId === m.deviceId && c.ownershipEpoch === m.ownershipEpoch,
        "Identity",
      );
      requireValue(
        c.sequence >= m.sequenceStart &&
          c.sequence <= m.sequenceEnd &&
          !seen.has(c.sequence),
        "Sequence",
      );
      requireValue(
        c.clockQuality === "untrusted" || c.capturedAt <= m.cutoffAt,
        "Future capture",
      );
      seen.add(c.sequence);
    }
    for (const gap of m.gaps) {
      requireValue(
        gap.sequenceStart >= m.sequenceStart &&
          gap.sequenceEnd <= m.sequenceEnd &&
          gap.sequenceEnd >= gap.sequenceStart,
        "Gap bounds",
      );
      for (let n = gap.sequenceStart; n <= gap.sequenceEnd; n++) {
        requireValue(!seen.has(n), "Overlapping gap");
        seen.add(n);
      }
    }
    requireValue(
      seen.size === m.sequenceEnd - m.sequenceStart + 1,
      "Missing sequence",
    );
  }
  if (kind === "CalendarBundle") {
    const { snapshot, pages, completion } = value as CalendarBundle;
    requireValue(snapshot.windowStart < snapshot.windowEnd, "Window");
    requireValue(pages.length === snapshot.pageCount, "Missing page");
    requireValue(
      pages.every(
        (p, i) => p.pageNumber === i && p.snapshotId === snapshot.snapshotId,
      ),
      "Page identity/order",
    );
    const hashes = pages.map(digest);
    requireValue(
      canonical(hashes) === canonical(completion.pageHashes),
      "Page hashes",
    );
    requireValue(
      sha256(hashes.join("\n")) === completion.completionDigest,
      "Completion digest",
    );
    const ids: string[] = [];
    for (const page of pages)
      for (const event of page.occurrences) {
        requireValue(
          snapshot.selectedCalendarIds.includes(event.calendarId),
          "Unselected calendar",
        );
        requireValue(
          event.startAt < event.endAt &&
            event.startAt < snapshot.windowEnd &&
            event.endAt > snapshot.windowStart,
          "Event interval",
        );
        new Intl.DateTimeFormat("en", { timeZone: event.timeZone });
        ids.push(event.occurrenceId);
      }
    requireValue(new Set(ids).size === ids.length, "Duplicate occurrence");
  }
  if (kind === "Transition") {
    const t = value as Transition;
    requireValue(
      t.revision === t.expectedRevision &&
        transitions[t.machine]?.[t.from]?.includes(t.to),
      "Stale/illegal transition",
    );
  }
}
export function decode<T>(kind: string, value: unknown): T {
  validate(kind, value);
  return value as T;
}
