import http from "node:http";
import { Engine, Fault, type Actor } from "./domain";
import {
  MAX_JSON_BYTES,
  MAX_RAW_BYTES,
  createRouter,
  errorEnvelope,
  type RouteResponse,
} from "./router";

function authenticate(header: string | undefined): Actor {
  // These are public, synthetic development identities, not credentials.
  const actors: Record<string, Actor> = {
    "Bearer local-user-a": { owner: "user_a", deviceId: null },
    "Bearer local-user-b": { owner: "user_b", deviceId: null },
    "Bearer local-device-a": { owner: "user_a", deviceId: "dev_sample_001" },
    "Bearer local-device-b": { owner: "user_b", deviceId: "dev_sample_002" },
  };
  const actor = actors[header ?? ""];
  if (!actor) throw new Fault(401, "UNAUTHENTICATED");
  return actor;
}
async function body(
  request: http.IncomingMessage,
  raw: boolean,
): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > (raw ? MAX_RAW_BYTES : MAX_JSON_BYTES))
      throw new Fault(422, "SIZE_MISMATCH");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Loopback-only development server over the shared router. */
export function createLocalServer(engine: Engine): http.Server {
  const route = createRouter(engine, { local: true });
  return http.createServer(async (request, response) => {
    const send = (result: RouteResponse): void => {
      if (result.raw) {
        response.writeHead(result.status, {
          "Content-Type": result.raw.contentType,
          "Cache-Control": "no-store",
        });
        response.end(Buffer.from(result.raw.bytes));
        return;
      }
      response.writeHead(result.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(
        result.body === undefined ? undefined : JSON.stringify(result.body),
      );
    };
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health" && request.method === "GET") {
        send({ status: 200, body: { ok: true, synthetic: true } });
        return;
      }
      const actor = authenticate(request.headers.authorization);
      const bytes = await body(
        request,
        url.pathname.startsWith("/local/uploads/"),
      );
      send(
        await route({
          method: request.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          body: bytes,
          actor,
          origin: `http://127.0.0.1:${request.socket.localPort!}`,
        }),
      );
    } catch (error) {
      send(errorEnvelope(error));
    }
  });
}
