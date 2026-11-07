import { sha256 } from "./contracts";

// Stable at maximum wire ID length, and independent of moment order or clock changes.
export const momentID = (captureId: string): string =>
  "moment_" +
  (captureId.length <= 89 ? captureId : sha256(captureId).slice(0, 40));
