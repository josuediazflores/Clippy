import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  Engine,
  initialState,
  type LocalState,
} from "../services/backend/src/domain";
import {
  LocalJournalStore,
  LocalObjectStore,
} from "../services/backend/src/adapters/local-store";
import { createLocalServer } from "../services/backend/src/http";
import { validate } from "../services/backend/src/contracts";
import type { Day } from "../services/backend/src/Wire";

const ui = process.argv.includes("--ui");
const directory = path.resolve(".local/scenario");
const evidence = path.resolve(".local/evidence");
fs.rmSync(directory, { recursive: true, force: true });
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync("fixtures/ui", { recursive: true });
const engine = new Engine(
  new LocalJournalStore<LocalState>(
    path.join(directory, "state.json"),
    initialState,
  ),
  new LocalObjectStore(path.join(directory, "objects")),
);
const server = createLocalServer(engine);
const run = async (
  command: string,
  args: string[],
  maxMS = 180000,
): Promise<string> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, PYTHONPATH: path.resolve("device") },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    const log =
      command === "xcodebuild" ? path.join(evidence, "P03-ui-build.log") : null;
    if (log) fs.writeFileSync(log, "");
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (log) fs.appendFileSync(log, chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error(`${command} exceeded its finite time limit`));
    }, maxMS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(Error(`${command} failed (${code})\n${output.slice(-6000)}`));
    });
  });
const deadline = setTimeout(() => {
  server.closeAllConnections();
  server.close();
}, 900000);
async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ui ? 8787 : 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const api = async <T>(
    method: string,
    route: string,
    payload?: unknown,
    key = "scenario_op",
  ): Promise<T> => {
    const response = await fetch(base + route, {
      method,
      headers: {
        Authorization: "Bearer local-user-a",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await response.json();
    assert.ok(response.ok, JSON.stringify(body));
    return body as T;
  };
  const save = (name: string, day: Day): void => {
    validate("Day", day);
    fs.writeFileSync(
      `fixtures/ui/${name}.json`,
      JSON.stringify(day, null, 2) + "\n",
    );
  };
  save("empty", await api<Day>("GET", "/v1/days/day_20261107"));
  const python = [
    "run",
    "python",
    "-m",
    "clippy_device.sync",
    "--url",
    base,
    "--queue",
    path.join(directory, "first"),
    "--count",
    "2",
  ];
  await run("uv", [...python, "--stop-after", "first-upload"]);
  assert.equal(
    engine.getDay({ owner: "user_a", deviceId: null }, "day_20261107").state,
    "empty",
  );
  await run("uv", python);
  const pending = await api<Day>("GET", "/v1/days/day_20261107");
  save("pending", pending);
  // Branch only the local adapter state for deterministic UI fault fixtures.
  const baseline = structuredClone(engine.state);
  await api("POST", "/local/process", {
    dayId: "day_20261107",
    mode: "partial",
  });
  save("partial", await api<Day>("GET", "/v1/days/day_20261107"));
  engine.state = structuredClone(baseline);
  engine.flush();
  const failure = await fetch(base + "/local/process", {
    method: "POST",
    headers: {
      Authorization: "Bearer local-user-a",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ dayId: "day_20261107", mode: "failure" }),
  });
  assert.equal(failure.status, 503);
  await failure.arrayBuffer();
  save("failure", await api<Day>("GET", "/v1/days/day_20261107"));
  engine.state = structuredClone(baseline);
  engine.flush();
  await api("POST", "/local/process", { dayId: "day_20261107", mode: "ready" });
  const first = await api<Day>("GET", "/v1/days/day_20261107");
  assert.equal(first.recap?.moments.length, 2);
  await api(
    "PUT",
    "/v1/days/day_20261107/reflections/reflection_main",
    {
      schemaVersion: 1,
      operationId: "scenario_reflection",
      expectedRevision: 0,
      text: "I made time for a quiet break.",
      deleted: false,
    },
    "scenario_reflection",
  );
  await api(
    "PUT",
    "/v1/moments/moment_cap_sample_001/corrections/correction_moment_cap_sample_001",
    {
      schemaVersion: 1,
      operationId: "scenario_correction",
      expectedRevision: 0,
      text: "A quiet break",
      deleted: false,
    },
    "scenario_correction",
  );
  const secondArgs = [
    "run",
    "python",
    "-m",
    "clippy_device.sync",
    "--url",
    base,
    "--queue",
    path.join(directory, "second"),
    "--start",
    "2",
    "--count",
    "2",
    "--trigger",
    "nightly",
  ];
  await run("uv", secondArgs);
  await run("uv", secondArgs);
  await api("POST", "/local/process", { dayId: "day_20261107", mode: "ready" });
  const ready = await api<Day>("GET", "/v1/days/day_20261107");
  save("ready", ready);
  assert.equal(ready.recap?.moments.length, 3);
  assert.equal(new Set(ready.recap?.moments.map((m) => m.momentId)).size, 3);
  assert.equal(ready.reflections[0]?.text, "I made time for a quiet break.");
  assert.equal(ready.reflections[0]?.revision, 1);
  assert.equal(ready.corrections[0]?.text, "A quiet break");
  assert.equal(ready.corrections[0]?.revision, 1);
  const report: Record<string, unknown> = {
    evidence: "local synthetic adapters only",
    firstSnapshotMoments: 2,
    secondSnapshotMoments: 3,
    uniqueMoments: 3,
    inputRevision: ready.inputRevision,
    recapRevision: ready.recap?.recapRevision,
    reflectionPreserved: true,
    correctionPreserved: true,
    duplicateReplayPassed: true,
    interruptedUploadResumed: true,
    states: ["empty", "pending", "partial", "ready", "failure"],
    ui: "not_run",
  };
  console.log(
    "Local scenario passed: Python capture -> HTTP immutable upload -> verified manifest -> mock recap -> user edits -> second snapshot.",
  );
  if (ui) {
    let simulator = process.env.CLIPPY_SIMULATOR_ID;
    const idFile = path.resolve(".local/simulator-id");
    if (!simulator && fs.existsSync(idFile))
      simulator = fs.readFileSync(idFile, "utf8").trim();
    if (!simulator) {
      simulator = (
        await run("xcrun", [
          "simctl",
          "create",
          "Clippy P03",
          "com.apple.CoreSimulator.SimDeviceType.iPhone-17e",
          "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        ])
      ).trim();
      fs.writeFileSync(idFile, simulator + "\n");
    }
    const result = path.join(evidence, "P03-ui.xcresult");
    fs.rmSync(result, { recursive: true, force: true });
    console.log(`Building and testing iPhone Simulator ${simulator}.`);
    const build = await run(
      "xcodebuild",
      [
        "-project",
        "apps/ios/Clippy.xcodeproj",
        "-scheme",
        "Clippy",
        "-configuration",
        "Debug",
        "-destination",
        `platform=iOS Simulator,id=${simulator}`,
        "-derivedDataPath",
        ".build-local/ios",
        "-resultBundlePath",
        result,
        "-parallel-testing-enabled",
        "NO",
        "CODE_SIGNING_ALLOWED=NO",
        "test",
      ],
      420000,
    );
    fs.writeFileSync(path.join(evidence, "P03-ui-build.log"), build);
    const screenDirectory = path.join(evidence, "screenshots");
    fs.rmSync(screenDirectory, { recursive: true, force: true });
    await run("xcrun", [
      "xcresulttool",
      "export",
      "attachments",
      "--path",
      result,
      "--output-path",
      screenDirectory,
    ]);
    const edited = await api<Day>("GET", "/v1/days/day_20261107");
    assert.equal(
      edited.reflections.find((r) => r.recordId === "reflection_main")?.text,
      "UI reflection saved",
    );
    assert.equal(
      edited.corrections.find((r) => r.momentId === "moment_cap_sample_001")
        ?.text,
      "UI correction saved",
    );
    assert.equal(edited.reflections[0]?.revision, 2);
    assert.equal(edited.corrections[0]?.revision, 2);
    report.ui = "passed";
    report.uiWritesVerified = true;
    report.simulator = simulator;
    report.states = [
      "empty",
      "pending",
      "partial",
      "ready",
      "failure",
      "offline",
    ];
    console.log(
      "Simulator UI passed. HTTP read/write results verified; screenshots exported.",
    );
  }
  fs.writeFileSync(
    path.join(evidence, "P03-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("Report: .local/evidence/P03-report.json");
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(deadline);
    server.closeAllConnections();
    server.close();
  });
