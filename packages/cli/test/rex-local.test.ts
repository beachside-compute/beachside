import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRex, firstLine, registerRexHost, unregisterRexHost } from "../src/rex-local";

test("detects an override or executable on PATH", async () => {
  expect(await findRex({ BEACHSIDE_REX_BIN: "/custom/rex" })).toBe("/custom/rex");
  const directory = await mkdtemp(join(tmpdir(), "rex-detection-"));

  try {
    const executable = join(directory, process.platform === "win32" ? "rex.exe" : "rex");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    expect(await findRex({ PATH: directory })).toBe(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** An in-memory `rex hosts`, answering the commands the CLI runs. */
function fakeRex(hosts: { label: string; endpoints: string[]; held?: boolean }[] = []) {
  const calls: string[][] = [];

  const run = async (_binary: string, args: string[]) => {
    calls.push(args);
    const [, command, label, ...rest] = args;

    if (command === "--json")
      return JSON.stringify({
        hosts: hosts.map(({ held, ...host }) => ({ host, from: "home", held: held ?? false })),
      });

    const index = hosts.findIndex((host) => host.label.toLowerCase() === label!.toLowerCase());

    if (command === "add") {
      if (index >= 0) throw new Error(`a host named "${label}" already exists`);
      hosts.push({ label: label!, endpoints: rest });
    } else if (command === "edit") hosts[index]!.endpoints = [rest[1]!];
    else if (command === "remove") hosts.splice(index, 1);

    return "";
  };

  return { calls, hosts, run };
}

const web = "https://web.example.ts.net";

async function register(
  rex: ReturnType<typeof fakeRex>,
  find: () => Promise<string | undefined> = async () => "/rex",
) {
  const notes: string[] = [];
  await registerRexHost(
    "beachside-web",
    web,
    { REX_SERVER: "https://unrelated.example.ts.net" },
    new AbortController().signal,
    { note: (text) => notes.push(text) },
    { find, run: rex.run },
  );

  return notes;
}

test("registration: missing CLI points at Add Remote Host", async () => {
  const rex = fakeRex();
  const notes = await register(rex, async () => undefined);
  expect(rex.calls).toEqual([]);
  expect(notes[0]).toContain("not found");
  expect(notes[0]).toContain("Add Remote Host");
});

test("registration: adds a new label and says the app needs Add Remote Host", async () => {
  const rex = fakeRex();
  const notes = await register(rex);
  expect(rex.calls).toContainEqual(["hosts", "add", "beachside-web", web]);
  expect(rex.hosts).toEqual([{ label: "beachside-web", endpoints: [web] }]);
  expect(notes[0]).toBe("rex: saved beachside-web for the rex CLI (rex -S beachside-web)");
  expect(notes[1]).toContain("Add Remote Host");
});

test("registration: repoints a stale label instead of failing", async () => {
  const rex = fakeRex([{ label: "Beachside-Web", endpoints: ["https://old.example.ts.net"] }]);
  const notes = await register(rex);
  expect(rex.calls).toContainEqual(["hosts", "edit", "Beachside-Web", "--endpoint", web]);
  expect(rex.hosts[0]!.endpoints).toEqual([web]);
  expect(notes[0]).toContain("saved beachside-web");
});

test("registration: leaves a label that already points here", async () => {
  const rex = fakeRex([{ label: "beachside-web", endpoints: [web] }]);
  const notes = await register(rex);
  expect(rex.calls.filter((args) => args[1] !== "--json")).toEqual([]);
  expect(notes[0]).toContain("saved beachside-web");
});

test("registration: says when Rex holds the host for an unreachable home", async () => {
  const rex = fakeRex();
  const run = rex.run;
  rex.run = async (binary, args) => {
    const result = await run(binary, args);

    for (const host of rex.hosts) host.held = true;

    return result;
  };

  const notes = await register(rex);
  expect(notes[0]).toContain("next time rex hosts can");
});

test("registration: reports one line of a Rex failure", async () => {
  const notes = await register({
    calls: [],
    hosts: [],
    run: async (_binary, args) => {
      if (args[1] === "--json") throw new Error("unknown flag: --json");
      throw new Error("unknown command hosts");
    },
  });

  expect(notes).toEqual([
    "rex: could not save beachside-web for the rex CLI (unknown command hosts); add the connection address in Rex with Add Remote Host…",
  ]);
});

test("firstLine keeps the first stderr line without Rex's Error prefix", () => {
  expect(
    firstLine('\nError: a host named "x" already exists (https://x).\nRename it, or use: …\n'),
  ).toBe('a host named "x" already exists (https://x).');
});

for (const scenario of ["matching", "repointed", "missing"] as const) {
  test(`unregistration: ${scenario}`, async () => {
    const rex = fakeRex(
      scenario === "missing"
        ? []
        : [
            {
              label: "beachside-web",
              endpoints: [scenario === "matching" ? web : "https://elsewhere.ts.net"],
            },
          ],
    );

    const notes: string[] = [];
    await unregisterRexHost(
      "beachside-web",
      web,
      {},
      new AbortController().signal,
      { note: (text) => notes.push(text) },
      { find: async () => "/rex", run: rex.run },
    );

    if (scenario === "matching") {
      expect(rex.hosts).toEqual([]);
      expect(notes).toEqual(["rex: removed beachside-web from your rex hosts"]);
    } else {
      expect(rex.calls.filter((args) => args[1] === "remove")).toEqual([]);
      expect(notes).toEqual([]);
    }
  });
}

for (const app of ["Rex.app", "Rex Beta.app"]) {
  test(`finds the bundled CLI in ${app} and skips PATH directories`, async () => {
    const root = await mkdtemp(join(tmpdir(), "rex-bundle-"));

    try {
      await mkdir(join(root, "rex"));
      const helper = join(root, app, "Contents/Helpers/Rex Server.rex/Contents/MacOS");
      await mkdir(helper, { recursive: true });
      const binary = join(helper, "rex");
      await writeFile(binary, "", { mode: 0o755 });
      expect(await findRex({ PATH: root }, { platform: "darwin", appDirectories: [root] })).toBe(
        binary,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("looks for rex.exe on Windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "rex-windows-"));

  try {
    const binary = join(root, "rex.exe");
    await writeFile(binary, "", { mode: 0o755 });
    expect(await findRex({ PATH: root }, { platform: "win32" })).toBe(binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const alreadyAborted of [false, true]) {
  test(`cancellation does not report a registration failure (pre-aborted: ${alreadyAborted})`, async () => {
    const controller = new AbortController();
    const notes: string[] = [];
    const calls: string[][] = [];

    if (alreadyAborted) controller.abort();
    await registerRexHost(
      "web",
      "https://web.example.ts.net",
      {},
      controller.signal,
      { note: (note) => notes.push(note) },
      {
        find: async () => "/rex",
        run: async (_binary, args) => {
          calls.push(args);
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        },
      },
    );
    expect(notes).toEqual([]);
    expect(calls).toHaveLength(alreadyAborted ? 0 : 1);
  });
}
