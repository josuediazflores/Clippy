import path from "node:path";
import { Engine, initialState, type LocalState } from "./domain";
import { LocalJournalStore, LocalObjectStore } from "./adapters/local-store";
import { createLocalServer } from "./http";

const data = process.env.CLIPPY_LOCAL_DATA ?? ".local/server";
const port = Number(process.env.CLIPPY_LOCAL_PORT ?? 8787);
const maxSeconds = Number(process.env.CLIPPY_LOCAL_MAX_SECONDS ?? 180);
if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 900)
  throw new Error("Finite lifetime must be 1-900 seconds");
const engine = new Engine(
  new LocalJournalStore<LocalState>(
    path.join(data, "state.json"),
    initialState,
  ),
  new LocalObjectStore(path.join(data, "objects")),
);
const server = createLocalServer(engine);
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Synthetic local server: http://127.0.0.1:${port}; stops after ${maxSeconds}s or Ctrl-C.`,
  ),
);
const timeout = setTimeout(() => server.close(), maxSeconds * 1000);
const stop = (): void => {
  clearTimeout(timeout);
  server.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server.on("close", () => clearTimeout(timeout));
