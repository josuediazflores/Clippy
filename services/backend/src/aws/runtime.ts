import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SFNClient } from "@aws-sdk/client-sfn";
import { Engine } from "../domain";
import { DynamoStore } from "../store/dynamo";
import { createS3Client, S3Objects, S3Signer } from "./s3";
import { StepFunctionsJobStarter } from "./sfn";
import { safeLog } from "./log";

export interface RuntimeConfig {
  tables: {
    accounts: string;
    devices: string;
    journal: string;
    operations: string;
  };
  mediaBucket: string;
  recapStateMachineArn: string | null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing configuration ${name}`);
  return value;
}
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  return {
    tables: {
      accounts: required(env, "CLIPPY_TABLE_ACCOUNTS"),
      devices: required(env, "CLIPPY_TABLE_DEVICES"),
      journal: required(env, "CLIPPY_TABLE_JOURNAL"),
      operations: required(env, "CLIPPY_TABLE_OPERATIONS"),
    },
    mediaBucket: required(env, "CLIPPY_MEDIA_BUCKET"),
    recapStateMachineArn: env.CLIPPY_RECAP_STATE_MACHINE_ARN || null,
  };
}

/** One engine per Lambda container, built from configuration. Dispatch is always deferred. */
export function createAwsEngine(config: RuntimeConfig = readConfig()): Engine {
  const s3 = createS3Client();
  return new Engine({
    store: new DynamoStore(new DynamoDBClient({}), config.tables),
    objects: new S3Objects(s3, config.mediaBucket),
    signer: new S3Signer(s3, config.mediaBucket),
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    dispatch: "deferred",
    jobs: config.recapStateMachineArn
      ? new StepFunctionsJobStarter(
          new SFNClient({}),
          config.recapStateMachineArn,
        )
      : null,
    log: (event, fields) => safeLog(event, fields),
  });
}
