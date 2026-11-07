import { App, Tags } from "aws-cdk-lib";
import { DataStack } from "./data-stack";
import { RuntimeStack } from "./runtime-stack";
import fs from "node:fs";
import { assertTemplates } from "./assertions";
import {
  DEFAULT_CONFIG,
  assertCallable,
  type PipelineConfig,
} from "../../services/processing/src/config";

/**
 * Environment-agnostic synthesis: no account, region, credentials or lookups. Deployment
 * requires an approved packet (docs/deployment/P04-dev-packet.md) and CDK bootstrap.
 * Context flags (all default off/safe):
 *   clippy:env               environment name, default "dev"
 *   clippy:dispatcherEnabled enable the outbox stream trigger (separate approval)
 *   clippy:deviceRuleEnabled enable the IoT device request rule (separate approval)
 *   clippy:pipelineConfig    path to a reviewed PipelineConfig JSON; default: free mock models
 *   clippy:region            required with a Bedrock pipeline: models must be verified there
 */
/** Bedrock configurations must name verified models for the target region (D06). */
function pipelineConfig(app: App): PipelineConfig {
  const file = app.node.tryGetContext("clippy:pipelineConfig");
  if (!file) return DEFAULT_CONFIG;
  const config = JSON.parse(
    fs.readFileSync(String(file), "utf8"),
  ) as PipelineConfig;
  if (config.provider === "bedrock") {
    const region = String(app.node.tryGetContext("clippy:region") ?? "");
    assertCallable(config.observation, region);
    assertCallable(config.synthesis, region);
  }
  return config;
}

export function buildApp(context: Record<string, unknown> = {}) {
  const app = new App({
    outdir: ".local/cdk.out",
    analyticsReporting: false,
    context,
  });
  const flag = (name: string) =>
    String(app.node.tryGetContext(name)) === "true";
  const envName = String(app.node.tryGetContext("clippy:env") ?? "dev");
  if (!/^[a-z][a-z0-9]{1,11}$/.test(envName))
    throw new Error("Invalid clippy:env");
  const data = new DataStack(app, `ClippyData-${envName}`, {
    envName,
    description: `Clippy ${envName} persistent data (retained)`,
    callbackUrls: ["clippy://auth/callback"],
    logoutUrls: ["clippy://auth/signed-out"],
  });
  const runtime = new RuntimeStack(app, `ClippyRuntime-${envName}`, {
    envName,
    description: `Clippy ${envName} API, device ingestion and outbox runtime`,
    data,
    dispatcherEnabled: flag("clippy:dispatcherEnabled"),
    deviceRuleEnabled: flag("clippy:deviceRuleEnabled"),
    pipeline: pipelineConfig(app),
    apiRateLimit: 10,
    apiBurstLimit: 20,
  });
  runtime.addStackDependency(data);
  for (const stack of [data, runtime]) {
    Tags.of(stack).add("Project", "Clippy");
    Tags.of(stack).add("Environment", envName);
  }
  return { app, data, runtime };
}

if (require.main === module) {
  const { app, data, runtime } = buildApp();
  const summary = assertTemplates(data, runtime);
  const assembly = app.synth();
  if (assembly.manifest.missing?.length)
    throw new Error("Synthesis needed lookups");
  console.log(
    `CDK synth passed: ${summary.data} data + ${summary.runtime} runtime resources, ` +
      `${summary.checks} template assertions, no lookups, no credentials. ` +
      `Event triggers: dispatcher ${summary.dispatcherEnabled ? "ENABLED" : "disabled"}, ` +
      `device rule ${summary.deviceRuleEnabled ? "ENABLED" : "disabled"}.`,
  );
}
