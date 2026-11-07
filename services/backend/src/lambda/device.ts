import { DescribeEndpointCommand, IoTClient } from "@aws-sdk/client-iot";
import {
  IoTDataPlaneClient,
  PublishCommand,
} from "@aws-sdk/client-iot-data-plane";
import { Fault, type DeviceRecord, type Engine } from "../domain";
import { checked, errorEnvelope } from "../router";
import { validate } from "../contracts";
import { keys } from "../store/keys";
import { createAwsEngine } from "../aws/runtime";
import { metric, safeLog } from "../aws/log";
import type * as W from "../Wire";

export const DEVICE_REQUEST_TYPES = [
  "sync.begin",
  "upload.grants",
  "sync.complete",
  "state.report",
] as const;
export type DeviceRequestType = (typeof DEVICE_REQUEST_TYPES)[number];

/**
 * Shape produced by the IoT topic rule. thingName, clientId and principal come from rule
 * functions (topic(4), clientid(), principal()); the rest is selected field by field from
 * the untrusted device message, so a payload cannot supply its own identity fields.
 */
export interface DeviceRuleEvent {
  thingName: string;
  clientId: string;
  principal: string;
  schemaVersion?: unknown;
  requestId?: unknown;
  type?: unknown;
  snapshotId?: unknown;
  body?: unknown;
}
export interface DeviceResponse {
  schemaVersion: 1;
  requestId: string | null;
  type: string | null;
  status: number;
  body: unknown;
}
export interface DevicePublisher {
  publish(topic: string, payload: DeviceResponse): Promise<void>;
}
export const responseTopic = (thingName: string, requestId: string) =>
  `clippy/v1/devices/${thingName}/responses/${requestId}`;

const isId = (value: unknown): value is string => {
  try {
    validate("Id", value);
    return true;
  } catch {
    return false;
  }
};

export function createDeviceHandler(
  engine: Engine,
  publisher: DevicePublisher,
) {
  async function handle(event: DeviceRuleEvent): Promise<DeviceResponse> {
    const requestId = isId(event.requestId) ? event.requestId : null;
    const type = DEVICE_REQUEST_TYPES.includes(event.type as DeviceRequestType)
      ? (event.type as DeviceRequestType)
      : null;
    const respond = (status: number, body: unknown): DeviceResponse => ({
      schemaVersion: 1,
      requestId,
      type,
      status,
      body,
    });
    try {
      if (event.schemaVersion !== 1)
        throw new Fault(400, "UNSUPPORTED_VERSION");
      if (!requestId || !type) throw new Fault(400, "INVALID_REQUEST");
      // The IoT policy binds client ID to the attached thing; require the same identity here.
      if (!isId(event.thingName) || event.clientId !== event.thingName)
        throw new Fault(403, "FORBIDDEN");
      const identity = (await engine.store.get(keys.identity(event.thingName)))
        ?.data as DeviceRecord | undefined;
      if (!identity || identity.identity.claimState !== "owned")
        throw new Fault(403, "FORBIDDEN");
      if (identity.certificateId && identity.certificateId !== event.principal)
        throw new Fault(403, "FORBIDDEN");
      const actor = { owner: identity.owner, deviceId: event.thingName };
      const snapshotId = event.snapshotId ?? null;
      if (snapshotId !== null && !isId(snapshotId))
        throw new Fault(400, "INVALID_REQUEST");
      const route = `mqtt/${type}/${snapshotId ?? "-"}`;
      const mutate = <T>(
        status: number,
        fn: Parameters<typeof engine.mutate<T>>[6],
        codec?: Parameters<typeof engine.mutate<T>>[7],
      ) =>
        engine.mutate(
          actor,
          "MQTT",
          route,
          requestId,
          event.body,
          status,
          fn,
          codec,
        );
      if (type === "sync.begin") {
        const input = checked<W.BeginSync>("BeginSync", event.body);
        await engine.authorizeDevice(
          actor,
          input.deviceId,
          input.ownershipEpoch,
        );
        const result = await mutate(201, (tx) =>
          engine.begin(actor, input, tx),
        );
        return respond(result.status, result.body);
      }
      if (type === "state.report") {
        const input = checked<W.DeviceState>("DeviceState", event.body);
        return respond(200, await engine.reportState(actor, input));
      }
      if (!snapshotId) throw new Fault(400, "INVALID_REQUEST");
      await engine.checkSnapshotAccess(actor, snapshotId);
      if (type === "upload.grants") {
        const input = checked<W.GrantRequest>("GrantRequest", event.body);
        const result = await mutate(
          200,
          (tx) => engine.grants(actor, snapshotId, input, undefined, tx),
          engine.grantCodec(actor),
        );
        return respond(result.status, result.body);
      }
      const input = checked<W.CompleteSync>("CompleteSync", event.body);
      const result = await mutate(200, (tx) =>
        engine.complete(actor, snapshotId, input, tx),
      );
      return respond(result.status, result.body);
    } catch (error) {
      const envelope = errorEnvelope(
        error,
        requestId ? "req_" + requestId.slice(0, 90) : undefined,
      );
      // Infrastructure faults rethrow so Lambda's async retry and failure destination apply.
      if (!(error instanceof Fault)) throw error;
      return respond(envelope.status, envelope.body);
    }
  }
  return async (event: DeviceRuleEvent): Promise<void> => {
    const started = Date.now();
    const response = await handle(event);
    safeLog("device.request", {
      type: response.type,
      status: response.status,
      ms: Date.now() - started,
    });
    if (response.status >= 500) metric("DeviceRequestError", 1);
    // A response is only published to the authenticated thing's own topic.
    if (response.requestId && isId(event.thingName))
      await publisher.publish(
        responseTopic(event.thingName, response.requestId),
        response,
      );
  };
}

export class IotPublisher implements DevicePublisher {
  private client: Promise<IoTDataPlaneClient> | undefined;
  constructor(private readonly endpoint?: string) {}
  private connect(): Promise<IoTDataPlaneClient> {
    this.client ??= (async () => {
      const address =
        this.endpoint ||
        (
          await new IoTClient({}).send(
            new DescribeEndpointCommand({ endpointType: "iot:Data-ATS" }),
          )
        ).endpointAddress;
      if (!address) throw new Error("IoT data endpoint unavailable");
      return new IoTDataPlaneClient({ endpoint: `https://${address}` });
    })();
    return this.client;
  }
  async publish(topic: string, payload: DeviceResponse): Promise<void> {
    await (
      await this.connect()
    ).send(
      new PublishCommand({
        topic,
        qos: 1,
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
  }
}

let cached: ReturnType<typeof createDeviceHandler> | undefined;
export const handler = (event: DeviceRuleEvent) => {
  cached ??= createDeviceHandler(
    createAwsEngine(),
    new IotPublisher(process.env.CLIPPY_IOT_DATA_ENDPOINT),
  );
  return cached(event);
};
