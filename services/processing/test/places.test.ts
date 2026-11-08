import test from "node:test";
import assert from "node:assert/strict";
import { ReverseGeocodeCommand } from "@aws-sdk/client-geo-places";
import { setup, upload, capture, app } from "../../backend/test/helpers";
import { jobIdFor } from "../../backend/src/domain";
import {
  DEFAULT_CONFIG,
  pipelineVersion,
  type PipelineConfig,
} from "../src/config";
import { Pipeline } from "../src/pipeline";
import { runJobLocally } from "../src/local-runner";
import {
  AmazonLocationPlaces,
  resolvePlaces,
  type PlaceResolver,
} from "../src/places";
import type { SynthesisModel, SynthesisInput } from "../src/providers/types";
import { MockObservationModel } from "../src/providers/mock-models";
import type * as W from "../../backend/src/Wire";

const dayId = "day_20261107";
const places: PipelineConfig = {
  ...DEFAULT_CONFIG,
  places: { ...DEFAULT_CONFIG.places, provider: "amazon-location" },
};
// Synthetic positions in open water off the California coast; not anyone's location.
const fix = (
  lat: number,
  lon: number,
  accuracy = 8,
  sampledAt?: string,
): W.Location => ({
  latitude: lat,
  longitude: lon,
  accuracyMeters: accuracy,
  sampledAt: sampledAt ?? "2026-11-07T09:00:00Z",
  source: "gnss",
});
const withFix = (sequence: number, location: W.Location | null) => {
  const c = capture(sequence);
  c.value = {
    ...c.value,
    location: location && {
      ...location,
      sampledAt:
        location.sampledAt === "auto" ? c.value.capturedAt : location.sampledAt,
    },
  };
  return c;
};
class Recording implements PlaceResolver {
  readonly version = "test";
  cells: Array<{ latitude: number; longitude: number }> = [];
  constructor(private readonly fail = false) {}
  async label(cell: { latitude: number; longitude: number }) {
    this.cells.push(cell);
    if (this.fail) throw new Error("ThrottlingException");
    return "Test Harbor, Synthetic City";
  }
}

test("only accurate, fresh fixes are labelled; one rounded lookup serves a whole cell", async () => {
  const captures = [
    withFix(1, fix(36.123456, -122.654321, 8, "auto")).value,
    withFix(2, fix(36.123401, -122.654333, 12, "auto")).value, // same ~110 m cell
    withFix(3, fix(36.2, -122.7, 900, "auto")).value, // too inaccurate
    withFix(4, fix(36.3, -122.8, 8, "2026-11-07T00:00:00Z")).value, // stale fix
    withFix(5, null).value, // no fix
  ];
  const resolver = new Recording();
  const result = await resolvePlaces(captures, resolver, places.places);
  assert.equal(result.lookups, 1);
  assert.deepEqual(resolver.cells, [{ latitude: 36.123, longitude: -122.654 }]);
  assert.deepEqual(
    [...result.labels.entries()],
    [
      ["cap_sample_001", "Test Harbor, Synthetic City"],
      ["cap_sample_002", "Test Harbor, Synthetic City"],
    ],
  );
  const off = await resolvePlaces(captures, resolver, DEFAULT_CONFIG.places);
  assert.equal(off.lookups, 0);
});

test("lookup failures leave labels empty without failing the job", async () => {
  const captures = [withFix(1, fix(36.1, -122.6, 8, "auto")).value];
  const result = await resolvePlaces(
    captures,
    new Recording(true),
    places.places,
  );
  assert.equal(result.failures, 1);
  assert.equal(result.labels.get("cap_sample_001"), null);
});

test("the model sees an area label, never coordinates; the moment detail carries the label", async (t) => {
  const h = await setup(t);
  await (
    await upload(h.engine, [
      withFix(1, fix(36.123456, -122.654321, 8, "auto")),
      withFix(2, null),
    ])
  ).finish();
  const inputs: SynthesisInput[] = [];
  const synthesis: SynthesisModel = {
    providerVersion: "fake",
    write: async (input) => {
      inputs.push(input);
      return {
        draft: {
          summary: "You were near the harbor.",
          reflectionPrompt: "What stood out?",
          titles: [],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        refused: false,
      };
    },
  };
  const resolver = new Recording();
  const pipeline = new Pipeline(
    h.engine,
    { observation: new MockObservationModel(), synthesis },
    places,
    () => {},
    resolver,
  );
  const result = await runJobLocally(
    pipeline,
    {
      owner: app.owner,
      dayId,
      jobId: jobIdFor(app.owner, dayId, 1, pipelineVersion(places)),
      inputRevision: 1,
    },
    { sleep: async () => {} },
  );
  assert.equal(result.status, "published");
  const sent = JSON.stringify(inputs[0]);
  assert.ok(sent.includes("Test Harbor, Synthetic City"));
  assert.ok(!/36\.12|122\.65/.test(sent), "no coordinates in the model input");
  const day = await h.engine.getDay(app, dayId);
  assert.equal(
    day.recap!.moments[0]!.detail.startsWith(
      "Near Test Harbor, Synthetic City.",
    ),
    true,
  );
  assert.equal(day.recap!.moments[1]!.detail.startsWith("Near"), false);
  assert.equal(
    (await h.engine.listJobs(app.owner, dayId))[0]!.usage!.placeLookups,
    1,
  );
});

test("Amazon Location adapter sends [lon, lat] with Storage use and keeps only area names", async () => {
  const commands: ReverseGeocodeCommand[] = [];
  const client = {
    send: async (command: ReverseGeocodeCommand) => {
      commands.push(command);
      return {
        ResultItems: [
          {
            Title: "123 Synthetic St, Test City",
            Address: {
              Label: "123 Synthetic St",
              Street: "Synthetic St",
              AddressNumber: "123",
              District: "Harbor District",
              Locality: "Test City",
              Region: { Name: "Test Region" },
            },
          },
        ],
      };
    },
  } as never;
  const label = await new AmazonLocationPlaces(client).label({
    latitude: 36.123,
    longitude: -122.654,
  });
  assert.equal(label, "Harbor District, Test City");
  assert.deepEqual(commands[0]!.input.QueryPosition, [-122.654, 36.123]);
  assert.equal(commands[0]!.input.IntendedUse, "Storage");
  const regionOnly = {
    send: async () => ({
      ResultItems: [{ Address: { Region: { Name: "Test Region" } } }],
    }),
  } as never;
  assert.equal(
    await new AmazonLocationPlaces(regionOnly).label({
      latitude: 1,
      longitude: 1,
    }),
    "Test Region",
  );
  const empty = { send: async () => ({ ResultItems: [] }) } as never;
  assert.equal(
    await new AmazonLocationPlaces(empty).label({ latitude: 1, longitude: 1 }),
    null,
  );
});

test("enabling place labels changes the pipeline version so caches never mix", () => {
  const bedrock: PipelineConfig = { ...DEFAULT_CONFIG, provider: "bedrock" };
  assert.notEqual(
    pipelineVersion(bedrock),
    pipelineVersion({ ...bedrock, places: places.places }),
  );
});
