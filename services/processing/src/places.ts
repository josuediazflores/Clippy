import {
  GeoPlacesClient,
  ReverseGeocodeCommand,
} from "@aws-sdk/client-geo-places";
import type * as W from "../../backend/src/Wire";
import type { PipelineConfig } from "./config";

/** Turns a rounded position into a coarse area label (neighborhood, city), or null. */
export interface PlaceResolver {
  readonly version: string;
  label(cell: { latitude: number; longitude: number }): Promise<string | null>;
}

export const NO_PLACES: PlaceResolver = {
  version: "none",
  label: async () => null,
};

/**
 * Amazon Location Places reverse geocoding. Only district, locality or region names are
 * kept: never the street, number or full address. Labels end up in stored recaps, so
 * IntendedUse is Storage as the service terms require.
 */
export class AmazonLocationPlaces implements PlaceResolver {
  readonly version = "amazon-location-v1";
  constructor(
    private readonly client: Pick<GeoPlacesClient, "send">,
    private readonly language = "en",
  ) {}
  async label(cell: { latitude: number; longitude: number }) {
    const result = await this.client.send(
      new ReverseGeocodeCommand({
        QueryPosition: [cell.longitude, cell.latitude],
        MaxResults: 1,
        IntendedUse: "Storage",
        Language: this.language,
      }),
    );
    const address = result.ResultItems?.[0]?.Address;
    if (!address) return null;
    const parts = [address.District, address.Locality].filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    );
    const label = parts.length
      ? parts.join(", ")
      : (address.Region?.Name ?? null);
    return label ? label.slice(0, 80) : null;
  }
}

export interface PlaceLookups {
  labels: Map<string, string | null>;
  lookups: number;
  failures: number;
}

/**
 * Labels for captures with a usable fix. Positions are rounded before lookup, so the
 * provider and the cache key never see the exact coordinate, and one call serves every
 * capture in the same cell. A failed lookup leaves the label empty; it never fails a job.
 */
export async function resolvePlaces(
  captures: W.Capture[],
  resolver: PlaceResolver,
  policy: PipelineConfig["places"],
): Promise<PlaceLookups> {
  const labels = new Map<string, string | null>();
  if (policy.provider === "none") return { labels, lookups: 0, failures: 0 };
  const scale = 10 ** policy.precisionDecimals;
  const cellOf = new Map<string, { latitude: number; longitude: number }>();
  const captureCell = new Map<string, string>();
  for (const c of captures) {
    const fix = c.location;
    if (
      !fix ||
      fix.accuracyMeters > policy.maxAccuracyMeters ||
      Math.abs(Date.parse(fix.sampledAt) - Date.parse(c.capturedAt)) / 1000 >
        policy.maxSampleAgeSeconds
    )
      continue;
    const latitude = Math.round(fix.latitude * scale) / scale;
    const longitude = Math.round(fix.longitude * scale) / scale;
    const key = `${latitude},${longitude}`;
    cellOf.set(key, { latitude, longitude });
    captureCell.set(c.captureId, key);
  }
  const cells = [...cellOf.entries()].slice(0, policy.maxLookupsPerJob);
  const resolved = new Map<string, string | null>();
  let failures = 0;
  const queue = [...cells];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          resolved.set(next[0], await resolver.label(next[1]));
        } catch {
          failures++;
          resolved.set(next[0], null);
        }
      }
    }),
  );
  for (const [captureId, key] of captureCell)
    labels.set(captureId, resolved.get(key) ?? null);
  return { labels, lookups: cells.length, failures };
}
