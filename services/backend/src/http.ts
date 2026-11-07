import http from "node:http";
import crypto from "node:crypto";
import { Engine, Fault, type Actor } from "./domain";
import { validate } from "./contracts";
import type * as W from "./Wire";
import {
  MockObservationProvider,
  MockRecapProvider,
} from "../../processing/src/mock";

function authenticate(header: string | undefined): Actor {
  // These are public, synthetic development identities, not credentials.
  const actors: Record<string, Actor> = {
    "Bearer local-user-a": { owner: "user_a", deviceId: null },
    "Bearer local-user-b": { owner: "user_b", deviceId: null },
    "Bearer local-device-a": { owner: "user_a", deviceId: "dev_sample_001" },
    "Bearer local-device-b": { owner: "user_b", deviceId: "dev_sample_002" },
  };
  const actor = actors[header ?? ""];
  if (!actor) throw new Fault(401, "UNAUTHENTICATED");
  return actor;
}
function checked<T>(kind: string, value: unknown): T {
  try {
    validate(kind, value);
  } catch {
    if (
      value &&
      typeof value === "object" &&
      "schemaVersion" in value &&
      value.schemaVersion !== 1
    )
      throw new Fault(400, "UNSUPPORTED_VERSION");
    throw new Fault(400, "INVALID_REQUEST");
  }
  return value as T;
}
async function body(
  request: http.IncomingMessage,
  raw: boolean,
): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > (raw ? 5000000 : 1000000)) throw new Fault(422, "SIZE_MISMATCH");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export function createLocalServer(engine: Engine): http.Server {
  return http.createServer(async (request, response) => {
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = url.pathname,
        method = request.method ?? "GET";
      if (route === "/health" && method === "GET") {
        send(200, { ok: true, synthetic: true });
        return;
      }
      const actor = authenticate(request.headers.authorization);
      const raw = route.startsWith("/local/uploads/");
      const bytes = await body(request, raw);
      let payload: unknown = null;
      if (bytes.length && !raw) {
        try {
          payload = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new Fault(400, "INVALID_REQUEST");
        }
      }
      const segments = route.split("/").filter(Boolean);
      for (const segment of segments.slice(2))
        if (
          ![
            "snapshots",
            "grants",
            "complete",
            "sync-requests",
            "cancel",
            "moments",
            "reflections",
            "corrections",
            "read-url",
          ].includes(segment)
        )
          checked("Id", segment);
      const operation =
        typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : "";
      const mutation = <T>(status: number, fn: () => T): void => {
        const result = engine.mutate(
          actor,
          method,
          route,
          operation,
          payload,
          status,
          fn,
        );
        send(result.status, result.body);
      };
      if (raw && method === "PUT") {
        engine.put(actor, segments[2]!, bytes, request.headers);
        send(201, undefined);
        return;
      }
      // Explicit finite-driver hook. No watcher, queue poller, cloud workflow, or schedule.
      if (route === "/local/process" && method === "POST") {
        const p = payload as { dayId?: string; mode?: string };
        if (
          !p ||
          !p.dayId ||
          !["ready", "partial", "failure"].includes(p.mode ?? "")
        )
          throw new Fault(400, "INVALID_REQUEST");
        engine.getDay(actor, p.dayId);
        const captures = Object.values(engine.state.captures).filter(
          (c) => c.owner === actor.owner && c.dayId === p.dayId,
        );
        const failed =
          p.mode === "partial" && captures.length
            ? new Set([captures.at(-1)!.value.captureId])
            : new Set<string>();
        send(
          200,
          engine.process(
            actor.owner,
            p.dayId,
            new MockObservationProvider(failed),
            new MockRecapProvider(),
            p.mode === "failure",
          ),
        );
        return;
      }
      if (route === "/v1/devices" && method === "GET") {
        send(200, engine.devices(actor, url.searchParams));
        return;
      }
      if (
        segments[1] === "devices" &&
        segments.length === 3 &&
        method === "GET"
      ) {
        send(200, engine.device(actor, segments[2]!));
        return;
      }
      if (
        segments[1] === "devices" &&
        segments[3] === "sync-requests" &&
        method === "POST"
      ) {
        checked("SyncRequestInput", payload);
        engine.device(actor, segments[2]!);
        mutation(202, () => engine.requestSync(actor, segments[2]!));
        return;
      }
      if (segments[1] === "sync-requests") {
        engine.getSync(actor, segments[2]!);
        if (method === "GET" && segments.length === 3) {
          send(200, engine.getSync(actor, segments[2]!));
          return;
        }
        if (method === "POST" && segments[3] === "cancel") {
          mutation(202, () => engine.cancelSync(actor, segments[2]!));
          return;
        }
      }
      if (route === "/v1/device/snapshots" && method === "POST") {
        const input = checked<W.BeginSync>("BeginSync", payload);
        if (!actor.deviceId) throw new Fault(403, "FORBIDDEN");
        engine.authorizeDevice(actor, input.deviceId, input.ownershipEpoch);
        mutation(201, () => engine.begin(actor, input));
        return;
      }
      if (
        segments[1] === "device" &&
        segments[2] === "snapshots" &&
        segments.length === 5 &&
        method === "POST"
      ) {
        const snapshotId = segments[3]!;
        engine.checkSnapshotAccess(actor, snapshotId);
        if (segments[4] === "grants") {
          const input = checked<W.GrantRequest>("GrantRequest", payload);
          engine.authorizeDevice(actor, input.deviceId, input.ownershipEpoch);
          const address = request.socket.localPort!;
          mutation(200, () =>
            engine.grants(
              actor,
              snapshotId,
              input,
              `http://127.0.0.1:${address}`,
            ),
          );
          return;
        }
        if (segments[4] === "complete") {
          const input = checked<W.CompleteSync>("CompleteSync", payload);
          engine.authorizeDevice(actor, input.deviceId, input.ownershipEpoch);
          mutation(200, () => engine.complete(actor, snapshotId, input));
          return;
        }
      }
      if (route === "/v1/days" && method === "GET") {
        send(200, engine.days(actor, url.searchParams));
        return;
      }
      if (segments[1] === "days" && segments.length === 3 && method === "GET") {
        send(200, engine.getDay(actor, segments[2]!));
        return;
      }
      if (
        segments[1] === "days" &&
        segments[3] === "moments" &&
        method === "GET"
      ) {
        const day = engine.getDay(actor, segments[2]!);
        send(
          200,
          engine.page(actor, route, url.searchParams, day.recap?.moments ?? []),
        );
        return;
      }
      if (
        method === "PUT" &&
        ((segments[1] === "days" && segments[3] === "reflections") ||
          (segments[1] === "moments" && segments[3] === "corrections")) &&
        segments.length === 5
      ) {
        const input = checked<W.EditInput>("EditInput", payload);
        if (input.operationId !== operation)
          throw new Fault(400, "INVALID_REQUEST");
        const kind = segments[1] === "days" ? "reflection" : "correction";
        if (kind === "reflection") engine.getDay(actor, segments[2]!);
        else engine.dayForMoment(actor, segments[2]!);
        mutation(200, () =>
          engine.saveEdit(actor, kind, segments[2]!, segments[4]!, input),
        );
        return;
      }
      if (
        method === "DELETE" &&
        segments.length <= 3 &&
        ["captures", "days", "me"].includes(segments[1] ?? "")
      ) {
        if (actor.deviceId) throw new Fault(403, "FORBIDDEN");
        const target = segments[1] === "me" ? "account" : segments[2]!;
        mutation(202, () => engine.delete(actor, target));
        return;
      }
      if (segments[1] === "deletion-jobs" && method === "GET") {
        send(200, engine.deletion(actor, segments[2]!));
        return;
      }
      throw new Fault(501, "NOT_IMPLEMENTED");
    } catch (error) {
      const fault =
        error instanceof Fault ? error : new Fault(500, "INTERNAL_ERROR");
      const envelope: W.APIError = {
        schemaVersion: 1,
        error: {
          code: fault.code,
          message:
            fault.code === "INTERNAL_ERROR"
              ? "The local operation could not complete."
              : fault.code.replaceAll("_", " ").toLowerCase(),
          requestId: "req_" + crypto.randomUUID().replaceAll("-", ""),
          retryable: fault.retryable,
          ...(fault.currentRevision === undefined
            ? {}
            : { currentRevision: fault.currentRevision }),
          ...(fault.itemIds ? { itemIds: fault.itemIds } : {}),
        },
      };
      send(fault.status, envelope);
    }
  });
}
