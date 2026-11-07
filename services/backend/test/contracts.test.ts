import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decode } from "../src/contracts";
import type { Day } from "../src/Wire";

test("typed day preserves recap provenance and user-authored reflection", () => {
  const day = decode<Day>(
    "Day",
    JSON.parse(fs.readFileSync("fixtures/valid/day.json", "utf8")),
  );
  assert.equal(day.recap?.moments[0]?.evidence[0]?.id, "cap_sample_001");
  assert.equal(day.reflections[0]?.revision, 1);
  assert.equal(day.reflections[0]?.text, "I enjoyed this synthetic day.");
});
