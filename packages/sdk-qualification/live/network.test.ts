import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { networkScript, networkSampleSchema } from "../provider-qualification/network-probe";
import type { AdapterSandbox } from "beachside";
import { TestResources } from "./fixtures/resources";
import { liveEnabled, setupLive, finishLive } from "./providers";

export async function networkControls(t: TestResources) {
  if (t.client.provider === "e2b" && t.imageId !== "base")
    throw Error("Network controls require the borrowed base template");

  const sample = async (box: AdapterSandbox) => {
    const output = await box.exec(
      {
        command: { kind: "argv", argv: ["python3", "-c", networkScript] },
        deadlineSeconds: 20,
        maxOutputBytes: 4096,
      },
      { signal: t.signal },
    );

    expect(output.truncated).toBe(false);
    expect(output.exitCode).toBe(0);
    expect(output.stderr.length).toBe(0);

    return networkSampleSchema.parse({ ...JSON.parse(output.stdoutText()), phase: "before" })
      .attempts;
  };

  const control = await t.create("network/control", undefined, "internet");
  expect((await sample(control)).every((attempt) => attempt.connected)).toBe(true);

  if (t.client.provider === "upstash-box")
    expect(await httpsSample(t, control)).toEqual([true, true]);

  const blocked = await t.create("network/blocked", undefined, "blocked");
  const denied = await sample(blocked);

  const deniedHttps =
    t.client.provider === "upstash-box" ? await httpsSample(t, blocked) : undefined;

  // Observe the after positive control even when a denied connection unexpectedly succeeds.
  expect((await sample(control)).every((attempt) => attempt.connected)).toBe(true);
  expect({ tcp: denied, https: deniedHttps }).toEqual({
    tcp: [
      {
        target: "hostname",
        connected: false,
        error: expect.stringMatching(/^(timeout|unreachable|denied)$/),
      },
      {
        target: "ipv4",
        connected: false,
        error: expect.stringMatching(/^(timeout|unreachable|denied)$/),
      },
    ],
    https: t.client.provider === "upstash-box" ? [false, false] : undefined,
  });
}

async function httpsSample(t: TestResources, box: AdapterSandbox) {
  const output = await box.exec(
    {
      command: {
        kind: "argv",
        argv: [
          "python3",
          "-c",
          "import http.client,json\nresults=[]\nfor host in ('example.com','www.cloudflare.com'):\n c=http.client.HTTPSConnection(host,timeout=4)\n try:\n  c.request('HEAD','/'); c.getresponse(); results.append(True)\n except (OSError,http.client.HTTPException): results.append(False)\n finally: c.close()\nprint(json.dumps(results))",
        ],
      },
      deadlineSeconds: 15,
      maxOutputBytes: 256,
    },
    { signal: t.signal },
  );

  expect(output.truncated).toBe(false);
  expect(output.stderr.length).toBe(0);

  return JSON.parse(output.stdoutText());
}

const provider = process.env.BEACHSIDE_QUAL_PROVIDER;

const allow =
  liveEnabled && provider === "upstash-box" && process.env.BEACHSIDE_UPSTASH_NETWORK === "allow";

const enabled = liveEnabled && (provider === "e2b" || provider === "upstash-box");
const selected = allow ? "network-allowlist" : "network-controls";

describe("Beachside network controls", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  beforeAll(async () => {
    if (enabled) {
      fixture = await setupLive([selected], { compute: allow ? 1 : 2, snapshots: 0, volumes: 0 });
      await fixture.resources.setup(() => fixture!.resources.open());
    }
  }, 96000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (enabled ? test : test.skip)(
    selected,
    async () => {
      const t = fixture!.resources;

      if (allow) {
        const box = await t.create("network/allowlist");
        expect(await httpsSample(t, box)).toEqual([true, false]);
      } else await networkControls(t);
    },
    241000,
  );
});
