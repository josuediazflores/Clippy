import test from "node:test";
import assert from "node:assert/strict";
import { ConditionFailed, queryAll, type Store } from "../src/store/store";
import { Tx } from "../src/store/tx";

/**
 * Behavior every Store adapter must share. Runs against the memory adapter by default
 * and against DynamoDB Local when CLIPPY_DYNAMODB_ENDPOINT is set.
 */
export function storeConformance(
  name: string,
  factory: () => Promise<Store>,
): void {
  const key = (pk: string, sk = "A") => ({
    table: "operations" as const,
    pk,
    sk,
  });
  const put = (pk: string, v: number, data: unknown, sk = "A") => ({
    op: "put" as const,
    item: { ...key(pk, sk), v, data },
  });

  test(`${name}: conditional create, versioned replace and stale replace`, async () => {
    const store = await factory();
    await store.transact([
      { ...put("C1", 1, { n: 1 }), condition: { absent: true } },
    ]);
    await assert.rejects(
      store.transact([
        { ...put("C1", 1, { n: 2 }), condition: { absent: true } },
      ]),
      ConditionFailed,
    );
    await store.transact([
      { ...put("C1", 2, { n: 2 }), condition: { version: 1 } },
    ]);
    await assert.rejects(
      store.transact([
        { ...put("C1", 2, { n: 3 }), condition: { version: 1 } },
      ]),
      ConditionFailed,
    );
    assert.deepEqual((await store.get(key("C1")))?.data, { n: 2 });
    assert.equal((await store.get(key("C1")))?.v, 2);
  });

  test(`${name}: a failed condition aborts every write in the transaction`, async () => {
    const store = await factory();
    await store.transact([
      { ...put("T1", 1, "kept"), condition: { absent: true } },
    ]);
    await assert.rejects(
      store.transact([
        { ...put("T2", 1, "new"), condition: { absent: true } },
        { op: "check", key: key("T1"), condition: { version: 9 } },
      ]),
      ConditionFailed,
    );
    assert.equal(await store.get(key("T2")), undefined);
    await assert.rejects(
      store.transact([
        { op: "delete", key: key("T1"), condition: { version: 1 } },
        { ...put("T3", 1, "x"), condition: { version: 4 } },
      ]),
      ConditionFailed,
    );
    assert.equal((await store.get(key("T1")))?.data, "kept");
  });

  test(`${name}: transaction bounds match DynamoDB`, async () => {
    const store = await factory();
    const writes = Array.from({ length: 101 }, (_, i) => ({
      ...put(`B${i}`, 1, i),
      condition: { absent: true } as const,
    }));
    await assert.rejects(store.transact(writes));
    await assert.rejects(store.transact([put("D1", 1, 1), put("D1", 1, 2)]));
    await assert.rejects(
      store.transact([put("BIG", 1, "x".repeat(400 * 1024))]),
    );
    assert.equal(await store.get(key("BIG")), undefined);
  });

  test(`${name}: prefix queries page in sort order and sparse index only lists indexed items`, async () => {
    const store = await factory();
    const pk = "Q1";
    for (const sk of ["B#2", "B#1", "A#1", "B#3"])
      await store.transact([
        {
          op: "put",
          item: {
            ...key(pk, sk),
            v: 1,
            data: sk,
            ...(sk.startsWith("B")
              ? { opk: "QPENDING", osk: `2026#${sk}` }
              : {}),
          },
        },
      ]);
    const first = await store.query({
      table: "operations",
      pk,
      prefix: "B#",
      limit: 2,
    });
    assert.deepEqual(
      first.items.map((i) => i.sk),
      ["B#1", "B#2"],
    );
    assert.ok(first.next);
    const rest = await store.query({
      table: "operations",
      pk,
      prefix: "B#",
      after: first.next,
    });
    assert.deepEqual(
      rest.items.map((i) => i.sk),
      ["B#3"],
    );
    const indexed = await queryAll(store, {
      table: "operations",
      index: "pending",
      pk: "QPENDING",
    });
    assert.deepEqual(indexed.map((i) => i.sk).sort(), ["B#1", "B#2", "B#3"]);
    await store.transact([
      {
        op: "put",
        item: { ...key(pk, "B#2"), v: 2, data: "done" },
        condition: { version: 1 },
      },
    ]);
    const after = await queryAll(store, {
      table: "operations",
      index: "pending",
      pk: "QPENDING",
    });
    assert.deepEqual(after.map((i) => i.sk).sort(), ["B#1", "B#3"]);
  });

  test(`${name}: batch read and bulk delete`, async () => {
    const store = await factory();
    await store.transact([put("M1", 1, 1), put("M2", 1, 2)]);
    const found = await store.getMany([key("M2"), key("MX"), key("M1")]);
    assert.deepEqual(
      found.map((i) => i?.data),
      [2, undefined, 1],
    );
    await store.deleteMany([key("M1"), key("M2"), key("MX")]);
    assert.deepEqual(
      (await store.getMany([key("M1"), key("M2")])).map(Boolean),
      [false, false],
    );
  });

  test(`${name}: concurrent units on one item cannot both commit`, async () => {
    const store = await factory();
    await store.transact([put("U1", 1, 0)]);
    const a = new Tx(store),
      b = new Tx(store);
    const [va, vb] = await Promise.all([
      a.get<number>(key("U1")),
      b.get<number>(key("U1")),
    ]);
    a.put(key("U1"), va! + 1);
    b.put(key("U1"), vb! + 1);
    const results = await Promise.allSettled([a.commit(), b.commit()]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await store.get(key("U1")))?.data, 1);
  });
}
