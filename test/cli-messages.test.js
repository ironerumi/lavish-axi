import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { sessionKey } from "../src/session-store.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

test("messages reads legacy history with or without the daemon without modifying state", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-messages-")));
  const artifact = path.join(dir, "review.html");
  const stateFile = path.join(dir, "state.json");
  const key = sessionKey(artifact);
  await writeFile(artifact, "<p>review</p>");
  const state = JSON.stringify({
    sessions: {
      [key]: {
        key,
        file: artifact,
        status: "ended",
        dom_snapshot: "PRIVATE_SNAPSHOT",
        chat: [
          { role: "user", text: "legacy note" },
          { role: "agent", text: "**plain reply**", html: "RENDERED_HTML" },
        ],
      },
    },
  });
  const server = await serve({
    hosts: ["127.0.0.1"],
    linkHost: "127.0.0.1",
    port: 0,
    stateFile,
    version: VERSION,
    log() {},
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(stateFile, state);
  const run = (...args) =>
    exec(process.execPath, [cli, "messages", "--limit=1", artifact, ...args], {
      env: {
        ...process.env,
        LAVISH_AXI_HOST: "127.0.0.1",
        LAVISH_AXI_PORT: String(server.port),
        LAVISH_AXI_STATE_DIR: dir,
        LAVISH_AXI_TELEMETRY: "0",
      },
    });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/${key}/messages`);
  assert.equal(response.status, 200);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${server.port}/api/${key}/messages`, {
        headers: { Origin: "https://other.example" },
      })
    ).status,
    403,
  );
  const online = await run();
  assert.match(online.stdout, /\*\*plain reply\*\*/);
  assert.match(online.stdout, /more_messages: 1/);
  assert.doesNotMatch(online.stdout, /legacy note|PRIVATE_SNAPSHOT|RENDERED_HTML|dom_snapshot:/);
  assert.match((await run("--role", "user")).stdout, /pre-receipt/);
  assert.equal(await readFile(stateFile, "utf8"), state);
  await server.close();
  assert.equal((await run()).stdout, online.stdout);
  assert.equal(await readFile(stateFile, "utf8"), state);
  await assert.rejects(run("--since-seq=-1"), (error) => {
    assert.ok(error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string");
    assert.match(error.stdout, /VALIDATION_ERROR/);
    assert.match(error.stdout, /--since-seq requires a non-negative integer/);
    return true;
  });
});
