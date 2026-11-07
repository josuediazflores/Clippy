import crypto from "node:crypto";
import { Engine, Fault, type Actor } from "./domain";
import { validate } from "./contracts";
import { keys } from "./store/keys";
import type * as W from "./Wire";
import {
  MockObservationProvider,
  MockRecapProvider,
} from "../../processing/src/mock";

export interface RouteRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** Lower-case header names. */
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
  actor: Actor;
  /** Base URL for local loopback grants. Unused by AWS signers. */
  origin?: string;
  requestId?: string;
}
export interface RouteResponse {
  status: number;
  body?: unknown;
  raw?: { bytes: Uint8Array; contentType: string };
  /** Safe metadata for operational logs. Never contains bodies, tokens or URLs. */
  code?: string;
}
export interface RouterOptions {
  /** Enables loopback-only device, upload and processing routes. Never enabled in AWS. */
  local: boolean;
  /** Receives unexpected (non-Fault) errors so adapters can record safe metadata. */
  onUnexpected?: (error: unknown) => void;
}

/** Error class and HTTP status only: provider messages can echo keys or values. */
export function safeErrorFields(
  error: unknown,
): Record<string, string | number> {
  const e = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return {
    errorName: typeof e?.name === "string" ? e.name.slice(0, 80) : "unknown",
    httpStatus:
      typeof e?.$metadata?.httpStatusCode === "number"
        ? e.$metadata.httpStatusCode
        : 0,
  };
}

const LITERALS = new Set([
  "snapshots",
  "grants",
  "complete",
  "sync-requests",
  "cancel",
  "moments",
  "reflections",
  "corrections",
  "read-url",
  "preferences",
]);
export const MAX_JSON_BYTES = 1000000;
export const MAX_RAW_BYTES = 5000000;

export function checked<T>(kind: string, value: unknown): T {
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

export function errorEnvelope(
  error: unknown,
  requestId = "req_" + crypto.randomUUID().replaceAll("-", ""),
): RouteResponse {
  const fault =
    error instanceof Fault ? error : new Fault(500, "INTERNAL_ERROR");
  const envelope: W.APIError = {
    schemaVersion: 1,
    error: {
      code: fault.code,
      message:
        fault.code === "INTERNAL_ERROR"
          ? "The operation could not complete."
          : fault.code.replaceAll("_", " ").toLowerCase(),
      requestId,
      retryable: fault.retryable,
      ...(fault.currentRevision === undefined
        ? {}
        : { currentRevision: fault.currentRevision }),
      ...(fault.itemIds ? { itemIds: fault.itemIds } : {}),
    },
  };
  return { status: fault.status, body: envelope, code: fault.code };
}

/** Transport-independent routing shared by the local server and the API Lambda. */
export function createRouter(engine: Engine, options: RouterOptions) {
  return async function route(request: RouteRequest): Promise<RouteResponse> {
    try {
      return await dispatch(request);
    } catch (error) {
      if (!(error instanceof Fault)) options.onUnexpected?.(error);
      return errorEnvelope(error, request.requestId);
    }
  };

  async function dispatch(request: RouteRequest): Promise<RouteResponse> {
    const { actor, method, query } = request;
    const route = request.path;
    const raw = options.local && route.startsWith("/local/uploads/");
    if (request.body.length > (raw ? MAX_RAW_BYTES : MAX_JSON_BYTES))
      throw new Fault(422, "SIZE_MISMATCH");
    let payload: unknown = null;
    if (request.body.length && !raw) {
      try {
        payload = JSON.parse(Buffer.from(request.body).toString("utf8"));
      } catch {
        throw new Fault(400, "INVALID_REQUEST");
      }
    }
    const segments = route.split("/").filter(Boolean);
    if (segments[0] !== "v1" && !(options.local && segments[0] === "local"))
      throw new Fault(501, "NOT_IMPLEMENTED");
    for (const segment of segments.slice(2))
      if (!LITERALS.has(segment)) checked("Id", segment);
    const key = request.headers["idempotency-key"];
    const operation = typeof key === "string" ? key : "";
    const mutation = async <T>(
      status: number,
      fn: Parameters<typeof engine.mutate<T>>[6],
      codec?: Parameters<typeof engine.mutate<T>>[7],
    ): Promise<RouteResponse> => {
      const result = await engine.mutate(
        actor,
        method,
        route,
        operation,
        payload,
        status,
        fn,
        codec,
      );
      return { status: result.status, body: result.body };
    };

    if (options.local) {
      if (raw && method === "PUT") {
        await engine.put(actor, segments[2]!, request.body, request.headers);
        return { status: 201 };
      }
      if (segments[1] === "objects" && method === "GET") {
        const grant = (await engine.store.get(keys.grant(segments[2]!)))
          ?.data as
          { owner: string; objectKey: string; item: W.GrantItem } | undefined;
        if (!grant || grant.owner !== actor.owner || !grant.item.captureId)
          throw new Fault(404, "NOT_FOUND");
        await engine.readGrant(actor, grant.item.captureId);
        const bytes = await engine.objects.read(grant.objectKey, MAX_RAW_BYTES);
        if (!bytes) throw new Fault(404, "NOT_FOUND");
        return {
          status: 200,
          raw: { bytes, contentType: grant.item.contentType },
        };
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
        await engine.getDay(actor, p.dayId);
        const captures = await engine.dayCaptures(actor.owner, p.dayId);
        const failed =
          p.mode === "partial" && captures.length
            ? new Set([captures.at(-1)!.captureId])
            : new Set<string>();
        return {
          status: 200,
          body: await engine.process(
            actor.owner,
            p.dayId,
            new MockObservationProvider(failed),
            new MockRecapProvider(),
            p.mode === "failure",
          ),
        };
      }
      if (route === "/v1/device/snapshots" && method === "POST") {
        const input = checked<W.BeginSync>("BeginSync", payload);
        if (!actor.deviceId) throw new Fault(403, "FORBIDDEN");
        await engine.authorizeDevice(
          actor,
          input.deviceId,
          input.ownershipEpoch,
        );
        return mutation(201, (tx) => engine.begin(actor, input, tx));
      }
      if (
        segments[1] === "device" &&
        segments[2] === "snapshots" &&
        segments.length === 5 &&
        method === "POST"
      ) {
        const snapshotId = segments[3]!;
        await engine.checkSnapshotAccess(actor, snapshotId);
        if (segments[4] === "grants") {
          const input = checked<W.GrantRequest>("GrantRequest", payload);
          await engine.authorizeDevice(
            actor,
            input.deviceId,
            input.ownershipEpoch,
          );
          return mutation(
            200,
            (tx) => engine.grants(actor, snapshotId, input, request.origin, tx),
            engine.grantCodec(actor, request.origin),
          );
        }
        if (segments[4] === "complete") {
          const input = checked<W.CompleteSync>("CompleteSync", payload);
          await engine.authorizeDevice(
            actor,
            input.deviceId,
            input.ownershipEpoch,
          );
          return mutation(200, (tx) =>
            engine.complete(actor, snapshotId, input, tx),
          );
        }
      }
    }
    if (actor.deviceId) throw new Fault(403, "FORBIDDEN");

    if (route === "/v1/me" && method === "GET")
      return { status: 200, body: await engine.profile(actor) };
    if (route === "/v1/me/preferences" && method === "PATCH") {
      const input = checked<W.Preferences>("Preferences", payload);
      return mutation(200, (tx) => engine.preferences(actor, input, tx));
    }
    if (route === "/v1/devices" && method === "GET")
      return { status: 200, body: await engine.devices(actor, query) };
    if (segments[1] === "devices" && segments.length === 3 && method === "GET")
      return { status: 200, body: await engine.device(actor, segments[2]!) };
    if (
      segments[1] === "devices" &&
      segments[3] === "sync-requests" &&
      segments.length === 4 &&
      method === "POST"
    ) {
      checked("SyncRequestInput", payload);
      await engine.device(actor, segments[2]!);
      return mutation(202, (tx) => engine.requestSync(actor, segments[2]!, tx));
    }
    if (segments[1] === "sync-requests") {
      await engine.getSync(actor, segments[2]!);
      if (method === "GET" && segments.length === 3)
        return { status: 200, body: await engine.getSync(actor, segments[2]!) };
      if (
        method === "POST" &&
        segments[3] === "cancel" &&
        segments.length === 4
      )
        return mutation(202, (tx) =>
          engine.cancelSync(actor, segments[2]!, tx),
        );
    }
    if (route === "/v1/days" && method === "GET")
      return { status: 200, body: await engine.days(actor, query) };
    if (segments[1] === "days" && segments.length === 3 && method === "GET")
      return { status: 200, body: await engine.getDay(actor, segments[2]!) };
    if (
      segments[1] === "days" &&
      segments[3] === "moments" &&
      segments.length === 4 &&
      method === "GET"
    ) {
      const day = await engine.getDay(actor, segments[2]!);
      return {
        status: 200,
        body: await engine.page(actor, route, query, day.recap?.moments ?? []),
      };
    }
    if (
      segments[1] === "captures" &&
      segments[3] === "read-url" &&
      segments.length === 4 &&
      method === "POST"
    ) {
      const captureId = segments[2]!;
      await engine.readGrant(actor, captureId, request.origin);
      return mutation(
        200,
        (tx) =>
          engine.readGrant(actor, captureId, request.origin, undefined, tx),
        engine.readCodec(actor, captureId, request.origin),
      );
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
      if (kind === "reflection") await engine.getDay(actor, segments[2]!);
      else await engine.dayForMoment(actor, segments[2]!);
      return mutation(200, (tx) =>
        engine.saveEdit(actor, kind, segments[2]!, segments[4]!, input, tx),
      );
    }
    if (method === "DELETE") {
      const target =
        route === "/v1/me"
          ? ({ kind: "account" } as const)
          : segments.length === 3 && segments[1] === "captures"
            ? ({ kind: "capture", id: segments[2]! } as const)
            : segments.length === 3 && segments[1] === "days"
              ? ({ kind: "day", id: segments[2]! } as const)
              : null;
      if (target)
        return mutation(202, (tx) => engine.delete(actor, target, tx));
    }
    if (
      segments[1] === "deletion-jobs" &&
      segments.length === 3 &&
      method === "GET"
    )
      return { status: 200, body: await engine.deletion(actor, segments[2]!) };
    throw new Fault(501, "NOT_IMPLEMENTED");
  }
}
