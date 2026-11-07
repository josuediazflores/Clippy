import { App, Stack, BootstraplessSynthesizer } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import assert from "node:assert/strict";

// P02 only: no AWS resources, assets, providers, credentials, or schedules.
const app = new App({
  outdir: ".local/cdk.out",
  analyticsReporting: false,
  autoSynth: false,
  builtinCloudFormationValidation: false, // Empty foundation is intentionally not deployable.
});
const stack = new Stack(app, "ClippyLocalFoundation", {
  synthesizer: new BootstraplessSynthesizer(),
  description:
    "Local foundation placeholder. P04 owns the first resource proposal.",
});
const template = Template.fromStack(stack).toJSON();
assert.equal(Object.keys(template.Resources ?? {}).length, 0);
const assembly = app.synth();
assert.equal(assembly.manifest.missing?.length ?? 0, 0);
console.log("CDK synth passed: zero resources, zero lookups, no credentials.");
