import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AdapterSandbox } from "beachside";
import { liveEnabled, setupLive, finishLive, featureSupported, reopenSnapshot } from "./providers";
import { memoryProgram, memoryRead, processAbsent, quote } from "./fixtures/memory-probe";

const provider = process.env.BEACHSIDE_QUAL_PROVIDER ?? "daytona";

const upstash = provider === "upstash-box";

const access =
  provider === "daytona" || (upstash && process.env.BEACHSIDE_UPSTASH_PREVIEW === "protected")
    ? "protected"
    : "public";

const upstashRegular = upstash && process.env.BEACHSIDE_UPSTASH_BOX_KIND === "regular";
const checkPause = liveEnabled && upstashRegular && access === "protected";

const enabled =
  liveEnabled &&
  (provider === "daytona" ||
    (provider === "e2b" && process.env.BEACHSIDE_E2B_PREVIEW_ACCESS === "public") ||
    (provider === "boxd" &&
      featureSupported("previewPublic") &&
      process.env.BEACHSIDE_BOXD_PREVIEW_ACCESS === "public") ||
    (provider === "freestyle" && featureSupported("previewPublic")) ||
    upstashRegular);

describe("Beachside native HTTP preview", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  let box: AdapterSandbox;
  beforeAll(async () => {
    if (!enabled) return;
    fixture = await setupLive(
      [...(checkPause ? ["lifecycle-suspend-resume"] : []), `preview-${access}`],
      { compute: 1, snapshots: 0, volumes: 0 },
    );
    await fixture.resources.setup(async () => {
      await fixture!.resources.open();
      box = await fixture!.resources.create("preview/source");
    });
  }, 96000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (checkPause ? test : test.skip)(
    "lifecycle-suspend-resume",
    async () => {
      const configured = fixture!;
      const t = configured.resources;
      t.at("preview/regular-lifecycle");
      const path = `${configured.fileRoot}/beachside-pause-${t.ledger.runId}`;
      const bytes = Uint8Array.of(0, 255, 19);
      await box.writeFile(path, bytes, { signal: t.signal });

      const process = await box.processes.start(
        { command: { kind: "shell", script: `exec python3 -u -c ${quote(memoryProgram)}` } },
        { signal: t.signal },
      );

      try {
        expect(await t.exec(box, memoryRead)).toMatch(/\d/);
        expect((await box.inspect({ signal: t.signal })).expires).toEqual({ status: "none" });
        const suspended = await box.suspend({ signal: t.signal });
        expect(suspended.processes).toBe("terminated");
        expect(suspended.observation.state).toBe("stopped");
        const saved = JSON.parse(JSON.stringify(box.reference));
        await reopenSnapshot(configured, saved, {
          path,
          base64: Buffer.from(bytes).toString("base64"),
          expires: { status: "none" },
          inactive: true,
        });
        const reopened = await t.client.sandboxes.get(saved, { signal: t.signal });
        const resumed = await reopened.resume({ signal: t.signal });
        expect(resumed.reference).toEqual(saved);
        expect(resumed.execution).toBe("fresh");
        expect(resumed.observation.expires).toEqual({ status: "none" });
        expect(await t.read(reopened, path)).toEqual(bytes);
        expect(await t.exec(reopened, processAbsent)).toBe("PROCESS_ABSENT\n");
      } finally {
        await process.detach();
      }
    },
    241000,
  );
  (enabled ? test : test.skip)(
    `preview-${access}`,
    async () => {
      const t = fixture!.resources;
      const before = await box.inspect({ signal: t.signal });
      const empty = await box.preview(3001, { signal: t.signal });
      expect(empty.access).toBe(access); // Access exists even before a listener is started.

      // Without a listener a provider may answer with an error page or refuse the connection.
      const emptyResponse = await fetch(empty.url, {
        headers: empty.access === "protected" ? empty.headers : undefined,
        redirect: "manual",
        signal: t.signal,
      }).catch(() => undefined);

      t.signal.throwIfAborted();

      expect(emptyResponse?.ok ?? false).toBe(false);
      await emptyResponse?.body?.cancel();
      expect((await box.inspect({ signal: t.signal })).expires).toEqual(before.expires);

      // Owned compute cleanup stops this server; no process-control extension is exercised.
      const marker = `preview-${t.ledger.runId}`;
      const root = `/tmp/beachside-preview-${t.ledger.runId}`;
      await t.exec(box, `mkdir -m 700 '${root}' && printf '%s' '${marker}' > '${root}/index.html'`);
      const server = `python3 -m http.server 3000 --bind 0.0.0.0 --directory '${root}'`;

      if (upstash)
        await box.processes.start(
          { command: { kind: "shell", script: `exec ${server}` } },
          { signal: t.signal },
        );
      else await t.background(box, server);
      const preview = await box.preview(3000, { signal: t.signal });
      expect(preview.access).toBe(access);
      const headers = preview.access === "protected" ? preview.headers : undefined;
      // Bounded test readiness, independent from preview lookup's availability contract.
      const signal = AbortSignal.any([t.signal, AbortSignal.timeout(20000)]);
      let ready = false;

      while (!signal.aborted) {
        // A refused connection means the server is not up yet.
        const response = await fetch(preview.url, { headers, redirect: "manual", signal }).catch(
          () => undefined,
        );

        if (response?.ok && (await response.text()) === marker) {
          ready = true;
          break;
        }

        await response?.body?.cancel().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(ready).toBe(true);

      if (preview.access === "protected") {
        const invalid: Record<string, string> = upstash
          ? { Authorization: "Bearer invalid-token" }
          : { "x-daytona-preview-token": "invalid-token" };

        for (const auth of [undefined, invalid]) {
          const denied = await fetch(preview.url, {
            headers: auth,
            redirect: "manual",
            signal: t.signal,
          });

          expect(denied.ok).toBe(false);
          await denied.body?.cancel();
        }
      }

      const saved = box.reference!;

      const reopened = await t.client.sandboxes.get(JSON.parse(JSON.stringify(saved)), {
        signal: t.signal,
      });

      const again = await reopened.preview(3000, { signal: t.signal });
      expect(again.access).toBe(access);

      if (upstash && preview.access === "protected" && again.access === "protected") {
        const old = await fetch(preview.url, {
          headers: preview.headers,
          redirect: "manual",
          signal,
        });

        const current = await fetch(again.url, {
          headers: again.headers,
          redirect: "manual",
          signal,
        });

        expect(old.ok).toBe(false);
        await old.body?.cancel();
        expect(current.ok).toBe(true);
        expect(await current.text()).toBe(marker);
      }

      if (upstash && access === "public") expect(again.url).toBe(preview.url);
      expect(JSON.stringify(saved)).not.toContain("token");
      t.at("preview/owned-cleanup");
      await t.destroy("preview/source");
      await expect(box.preview(3000, { signal: t.signal })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    },
    241000,
  );
});
