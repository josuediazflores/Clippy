/**
 * Provisions one prototype device for printed-QR pairing (D50).
 *
 *   AWS_PROFILE=... AWS_REGION=us-east-1 npx tsx tools/provision-device.ts --device-id dev_clippy_001
 *
 * Creates an IoT thing named after the device, an active certificate with the device policy, and an
 * unclaimed device record holding only the SHA-256 of a one-time claim secret. Writes the certificate,
 * private key, agent config and a printable QR to .local/devices/<deviceId>/ (ignored by Git).
 * Refuses to touch a device ID that already exists. Removal steps are printed at the end.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DeviceRecord } from "../services/backend/src/domain";
import { keys } from "../services/backend/src/store/keys";
import { DynamoStore } from "../services/backend/src/store/dynamo";

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const deviceId = option("device-id", "dev_clippy_001");
const env = option("env", "dev");
const out = path.resolve(option("out", `.local/devices/${deviceId}`));
if (!/^[a-z][a-z0-9_]{2,95}$/.test(deviceId))
  throw new Error("device ID must match ^[a-z][a-z0-9_]{2,95}$");

const aws = (...command: string[]): string =>
  execFileSync("aws", [...command, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
const awsJson = <T>(...command: string[]): T =>
  JSON.parse(aws(...command)) as T;

async function main(): Promise<void> {
  // Table names come from the deployed Data stack, never from hand-typed values.
  const outputs = awsJson<{
    Stacks: Array<{
      Outputs: Array<{ OutputKey: string; OutputValue: string }>;
    }>;
  }>("cloudformation", "describe-stacks", "--stack-name", `ClippyData-${env}`)
    .Stacks[0]!.Outputs;
  const table = (name: string): string => {
    const found = outputs.find((o) =>
      o.OutputKey.startsWith(`ExportsOutputRef${name}Table`),
    );
    if (!found) throw new Error(`No ${name} table output on ClippyData-${env}`);
    return found.OutputValue;
  };
  const store = new DynamoStore(new DynamoDBClient({}), {
    accounts: table("Accounts"),
    devices: table("Devices"),
    journal: table("Journal"),
    operations: table("Operations"),
  });

  if (await store.get(keys.identity(deviceId)))
    throw new Error(
      `${deviceId} already has a device record; choose a new device ID`,
    );
  const things = awsJson<{ things: Array<{ thingName: string }> }>(
    "iot",
    "list-things",
  ).things;
  if (things.some((t) => t.thingName === deviceId))
    throw new Error(
      `IoT thing ${deviceId} already exists; choose a new device ID`,
    );
  if (fs.existsSync(out)) throw new Error(`${out} already exists`);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });

  const policy = `clippy-${env}-device`;
  const endpoint = awsJson<{ endpointAddress: string }>(
    "iot",
    "describe-endpoint",
    "--endpoint-type",
    "iot:Data-ATS",
  ).endpointAddress;
  const cert = awsJson<{ certificateArn: string; certificateId: string }>(
    "iot",
    "create-keys-and-certificate",
    "--set-as-active",
    "--certificate-pem-outfile",
    path.join(out, "certificate.pem"),
    "--private-key-outfile",
    path.join(out, "private.key"),
  );
  fs.chmodSync(path.join(out, "private.key"), 0o600);
  aws("iot", "create-thing", "--thing-name", deviceId);
  aws(
    "iot",
    "attach-policy",
    "--policy-name",
    policy,
    "--target",
    cert.certificateArn,
  );
  aws(
    "iot",
    "attach-thing-principal",
    "--thing-name",
    deviceId,
    "--principal",
    cert.certificateArn,
  );

  // The secret exists only in the QR. The database keeps its hash until the first claim clears it.
  const secret = "clm_" + crypto.randomBytes(16).toString("hex");
  const record: DeviceRecord = {
    owner: "",
    identity: {
      schemaVersion: 1,
      deviceId,
      ownershipEpoch: 1,
      protocolVersion: 1,
      firmwareVersion: "pi-agent-1",
      claimState: "unclaimed",
      configurationRevision: 1,
      appliedRevision: 1,
    },
    certificateId: cert.certificateId,
    claimSecretHash: crypto.createHash("sha256").update(secret).digest("hex"),
  };
  await store.transact([
    {
      op: "put",
      item: { ...keys.identity(deviceId), v: 1, data: record },
      condition: { absent: true },
    },
  ]);

  fs.writeFileSync(
    path.join(out, "config.json"),
    JSON.stringify(
      {
        deviceId,
        endpoint,
        cert: "certificate.pem",
        key: "private.key",
        captureIntervalSeconds: 600,
        nightlyUtc: "02:00",
        gpsPort: "/dev/serial0",
      },
      null,
      2,
    ) + "\n",
  );
  const url = `clippy://pair?v=1&d=${deviceId}&c=${secret}`;
  for (const [file, kind] of [
    ["qr.png", "png"],
    ["qr.svg", "svg"],
  ] as const)
    execFileSync(
      "uv",
      [
        "run",
        "--no-project",
        "--quiet",
        "--with",
        "segno==1.6.6",
        "python",
        "-I",
        "-c",
        "import segno,sys; segno.make(sys.argv[1], error='q').save(sys.argv[2], kind=sys.argv[3], scale=14, border=4)",
        url,
        path.join(out, file),
        kind,
      ],
      { stdio: "inherit" },
    );

  console.log(`Provisioned ${deviceId} (unclaimed).`);
  console.log(`  IoT endpoint: ${endpoint}`);
  console.log(`  Certificate:  ${cert.certificateId}`);
  console.log(
    `  Files:        ${out} (certificate, private key, config, qr.png, qr.svg)`,
  );
  console.log(`  Pairing URL:  ${url}`);
  console.log(
    "To remove: detach and delete the certificate, delete the thing, and delete the",
  );
  console.log(
    `DEVICE#${deviceId} item in ${table("Devices")} (see docs/handoffs/device-agent.md).`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
