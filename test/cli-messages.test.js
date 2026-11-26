import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { VERSION } from "../src/cli.js";
import { stateId } from "../src/paths.js";
import { serve } from "../src/server.js";
import { sessionKey } from "../src/session-store.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

test("messages reads owned pre-endpoint daemon history but preserves supported endpoint failures", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-messages-legacy-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        chat: [{ role: "user", text: "retained legacy note" }],
      },
    },
  });
  await writeFile(stateFile, state);
  let supportsMessages = false;
  let endpointStatus = 503;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") {
      res.end(
        JSON.stringify({
          app: "lavish-axi",
          version: VERSION,
          state_id: stateId(stateFile),
          ...(supportsMessages ? { supports_messages: true } : {}),
        }),
      );
    } else {
      res.statusCode = supportsMessages ? endpointStatus : 404;
      res.end(JSON.stringify(supportsMessages && endpointStatus === 200 ? { missing: true } : {}));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(
    () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined)))),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const run = () =>
    exec(process.execPath, [cli, "messages", artifact], {
      env: {
        ...process.env,
        LAVISH_AXI_HOST: "127.0.0.1",
        LAVISH_AXI_PORT: String(address.port),
        LAVISH_AXI_STATE_DIR: dir,
        LAVISH_AXI_TELEMETRY: "0",
      },
    });
  assert.match((await run()).stdout, /retained legacy note/);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request === "GET /health"));
  assert.equal(await readFile(stateFile, "utf8"), state);

  supportsMessages = true;
  await assert.rejects(run(), (error) => {
    assert.ok(error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string");
    assert.match(error.stdout, /SERVER_ERROR/);
    assert.match(error.stdout, /503/);
    return true;
  });
  endpointStatus = 200;
  await assert.rejects(run(), (error) => {
    assert.ok(error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string");
    assert.match(error.stdout, /NOT_FOUND/);
    return true;
  });
  const isMessagesRequest = (request) =>
    request.startsWith("GET ") && new URL(request.slice(4), "http://localhost").pathname === `/api/${key}/messages`;
  assert.ok(requests.some(isMessagesRequest));
  assert.ok(requests.every((request) => request === "GET /health" || isMessagesRequest(request)));
  assert.equal(await readFile(stateFile, "utf8"), state);
});

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
