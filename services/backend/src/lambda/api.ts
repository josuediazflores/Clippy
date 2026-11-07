import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { Fault, type Actor, type Engine } from "../domain";
import { createRouter, errorEnvelope, type RouteResponse } from "../router";
import { createAwsEngine } from "../aws/runtime";
import { metric, safeLog } from "../aws/log";

export interface ApiAuthConfig {
  clientId: string;
  requiredScope: string;
}

/**
 * API Gateway's JWT authorizer validates signature, issuer, expiry, audience/client_id and
 * route scopes. The handler re-checks the claims that distinguish an access token from an
 * ID token, because both carry the app client ID.
 */
export function actorFromClaims(
  claims: Record<string, string | number | boolean | string[]> | undefined,
  auth: ApiAuthConfig,
): Actor {
  if (!claims) throw new Fault(401, "UNAUTHENTICATED");
  const scopes = String(claims.scope ?? "").split(" ");
  if (
    claims.token_use !== "access" ||
    claims.client_id !== auth.clientId ||
    !scopes.includes(auth.requiredScope) ||
    typeof claims.sub !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(claims.sub)
  )
    throw new Fault(401, "UNAUTHENTICATED");
  return { owner: claims.sub, deviceId: null };
}

export function createApiHandler(engine: Engine, auth: ApiAuthConfig) {
  const route = createRouter(engine, { local: false });
  return async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const started = Date.now();
    const requestId =
      "req_" +
      event.requestContext.requestId.toLowerCase().replace(/[^a-z0-9]/g, "");
    let result: RouteResponse;
    try {
      const actor = actorFromClaims(
        event.requestContext.authorizer?.jwt?.claims,
        auth,
      );
      const body = event.body
        ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
        : new Uint8Array();
      result = await route({
        method: event.requestContext.http.method,
        path: event.rawPath,
        query: new URLSearchParams(event.rawQueryString ?? ""),
        headers: Object.fromEntries(
          Object.entries(event.headers ?? {}).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        body,
        actor,
        requestId,
      });
    } catch (error) {
      result = errorEnvelope(error, requestId);
    }
    // Route template, never the concrete path, query, body or token.
    safeLog("api.request", {
      route: event.routeKey,
      status: result.status,
      code: result.code ?? "OK",
      ms: Date.now() - started,
      requestId,
    });
    if (result.status >= 500) metric("ApiServerError", 1);
    return {
      statusCode: result.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: result.body === undefined ? "" : JSON.stringify(result.body),
    };
  };
}

let cached: ReturnType<typeof createApiHandler> | undefined;
export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  cached ??= createApiHandler(createAwsEngine(), {
    clientId: process.env.CLIPPY_COGNITO_CLIENT_ID ?? "",
    requiredScope: process.env.CLIPPY_REQUIRED_SCOPE ?? "",
  });
  return cached(event);
};
