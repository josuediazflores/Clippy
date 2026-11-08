import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CORPUS } from "./corpus";

/** Writes the synthetic corpus as PNGs using macOS sips. Finite, local, no network. */
const out = path.resolve(".local/eval/corpus");
fs.mkdirSync(out, { recursive: true });
for (const c of CORPUS) {
  const svg = path.join(out, `${c.id}.svg`);
  fs.writeFileSync(svg, c.svg);
  execFileSync(
    "sips",
    ["-s", "format", "png", svg, "--out", path.join(out, `${c.id}.png`)],
    { stdio: "ignore" },
  );
  fs.rmSync(svg);
}
console.log(`Wrote ${CORPUS.length} synthetic images to ${out}`);
