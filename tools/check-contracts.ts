import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  root,
  validate,
  canonical,
  digest,
} from "../services/backend/src/contracts";
const read = (file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const cases = read("fixtures/index.json") as Array<{
  file: string;
  schema: string;
  valid: boolean;
}>;
for (const c of cases) {
  let accepted = true;
  try {
    validate(c.schema, read(c.file));
  } catch {
    accepted = false;
  }
  assert.equal(accepted, c.valid, c.file);
}
const transitions = read("fixtures/transitions.json") as Array<{
  value: unknown;
  valid: boolean;
}>;
for (const c of transitions) {
  let accepted = true;
  try {
    validate("Transition", c.value);
  } catch {
    accepted = false;
  }
  assert.equal(accepted, c.valid, canonical(c.value));
}
const schema = read("contracts/schema.json") as { $defs: unknown };
const api = read("contracts/openapi.json") as {
  components: { schemas: unknown };
};
assert.equal(
  canonical(schema.$defs).replaceAll("#/$defs/", "#/components/schemas/"),
  canonical(api.components.schemas),
  "OpenAPI/schema drift",
);
assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
console.log(
  `TypeScript: ${cases.length} fixtures + ${transitions.length} state/revision cases passed; OpenAPI shapes agree.`,
);
