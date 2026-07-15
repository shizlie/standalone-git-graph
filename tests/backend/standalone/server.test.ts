import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

vi.mock("vscode", () => ({ l10n: { t: (key: string) => key } }));

import { createConfig, defaultOptions } from "@/standalone/config";
import { startServer, type Server } from "@/standalone/server";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("accepts a WebSocket connection when the persisted active repository was removed", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitgraph-state-"));
  tempDirs.push(stateDir);
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      lastActiveRepo: path.join(stateDir, "removed-repository"),
      repoStates: {},
      avatarCache: {}
    })
  );

  const options = { ...defaultOptions(), host: "127.0.0.1", open: false, port: 0, stateFile };
  const server = await startServer(createConfig(options), options, path.resolve("."));
  servers.push(server);
  const socket = new WebSocket(`${server.url.replace("http", "ws")}/ws`);

  await expect(once(socket, "open")).resolves.toBeDefined();
  socket.close();
});
