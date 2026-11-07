import { App, Tags } from "aws-cdk-lib";
import { DataStack } from "./data-stack";
import { RuntimeStack } from "./runtime-stack";
import { assertTemplates } from "./assertions";

/**
 * Environment-agnostic synthesis: no account, region, credentials or lookups. Deployment
 * requires an approved packet (docs/deployment/P04-dev-packet.md) and CDK bootstrap.
 * Context flags (all default off/safe):
 *   clippy:env               environment name, default "dev"
 *   clippy:dispatcherEnabled enable the outbox stream trigger (separate approval)
 *   clippy:deviceRuleEnabled enable the IoT device request rule (separate approval)
 */
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
    recapStateMachineArn: null,
    apiRateLimit: 10,
    apiBurstLimit: 20,
  });
  runtime.addDependency(data);
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
