import assert from "node:assert/strict";
import { test } from "node:test";
import { localDayId } from "../src/domain";
import { app, capture, setup, upload } from "./helpers";

const local = (
  sequence: number,
  at: string,
  timeZone: string,
  offset: number,
) => {
  const c = capture(sequence, at);
  c.value = { ...c.value, timeZone, utcOffsetSeconds: offset };
  return c;
};

test("captures land on their local date and new days use local midnight boundaries", async (t) => {
  const { engine } = await setup(t);
  // 9:30 PM Pacific on Nov 6 is 05:30 UTC on Nov 7 (before the helper snapshot cutoff).
  const evening = local(
    1,
    "2026-11-07T05:30:00Z",
    "America/Los_Angeles",
    -8 * 3600,
  );
  assert.equal(localDayId(evening.value), "day_20261106");
  await (await upload(engine, [evening])).finish();

  const day = await engine.getDay(app, "day_20261106");
  assert.equal(day.timeZone, "America/Los_Angeles");
  assert.equal(day.startAt, "2026-11-06T08:00:00Z");
  assert.equal(day.endAt, "2026-11-07T08:00:00Z");
  assert.equal(day.inputRevision, 1);
  assert.equal(
    (await engine.getDay(app, "day_20261107")).inputRevision,
    0,
    "nothing leaked into the UTC date",
  );
});

test("UTC captures keep UTC days, and a DST change day is 25 hours long", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1, "2026-11-07T09:00:00Z")])).finish();
  const utc = await engine.getDay(app, "day_20261107");
  assert.equal(utc.timeZone, "UTC");
  assert.equal(utc.startAt, "2026-11-07T00:00:00Z");
  assert.equal(utc.endAt, "2026-11-08T00:00:00Z");

  // US daylight saving time ends on 2026-11-01: midnight is UTC-7, the next midnight UTC-8.
  await (
    await upload(
      engine,
      [local(2, "2026-11-01T19:00:00Z", "America/Los_Angeles", -8 * 3600)],
      { key: "dst" },
    )
  ).finish();
  const dst = await engine.getDay(app, "day_20261101");
  assert.equal(dst.startAt, "2026-11-01T07:00:00Z");
  assert.equal(dst.endAt, "2026-11-02T08:00:00Z");
});
