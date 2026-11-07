import path from "node:path";
import { Engine, type EngineOptions } from "./domain";
import { LocalGrantSigner, LocalObjectStore } from "./adapters/local-store";
import { FileStore } from "./store/memory";
import type { Store } from "./store/store";
import { seedSynthetic } from "./seed";

/** Local adapters: file-persisted store, loopback grants, synthetic devices. */
export async function createLocalEngine<S extends Store = FileStore>(
  directory: string,
  options: Partial<EngineOptions> = {},
  injected?: S,
): Promise<{ engine: Engine; store: S; objects: LocalObjectStore }> {
  const store = (injected ??
    new FileStore(path.join(directory, "state.json"))) as S;
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
