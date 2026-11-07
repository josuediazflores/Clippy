import path from "node:path";
import { Engine, type EngineOptions } from "./domain";
import { LocalGrantSigner, LocalObjectStore } from "./adapters/local-store";
import { FileStore } from "./store/memory";
import { seedSynthetic } from "./seed";

/** Local adapters: file-persisted store, loopback grants, synthetic devices. */
export async function createLocalEngine(
  directory: string,
  options: Partial<EngineOptions> = {},
): Promise<{ engine: Engine; store: FileStore; objects: LocalObjectStore }> {
  const store = new FileStore(path.join(directory, "state.json"));
  const objects = new LocalObjectStore(path.join(directory, "objects"));
  await seedSynthetic(store);
  const engine = new Engine({
    store,
    objects,
    signer: new LocalGrantSigner(),
    dispatch: "inline",
    ...options,
  });
  return { engine, store, objects };
}
