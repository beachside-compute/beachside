/**
 * First-party adapter names that telemetry reports as-is. Any other adapter name is reported as
 * `custom`, so application-defined adapters cannot add unbounded or private label values.
 *
 * `provider-labels.test.ts` fails when a package under `packages/providers` declares a name that
 * is missing here, or when a name here no longer has a package.
 */
export const FIRST_PARTY_PROVIDERS: ReadonlySet<string> = new Set([
  "archil",
  "boat",
  "boxd",
  "daytona",
  "e2b",
  "exe-dev",
  "fake",
  "freestyle",
  "modal",
  "runloop",
  "upstash-box",
  "vercel",
]);

/** Bounded telemetry label for an adapter name. */
export function providerLabel(name: string): string {
  return FIRST_PARTY_PROVIDERS.has(name) ? name : "custom";
}
