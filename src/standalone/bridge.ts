/**
 * Server-side counterpart to the browser shim (`shim.ts`). Wraps a single
 * WebSocket connection with the same `post` / `onMessage` surface the upstream
 * `WebviewBridge` exposes, so `messageHandler.ts` (reused verbatim) binds to it.
 */
import type { WebSocket } from "ws";

import type { RequestMessage, ResponseMessage } from "@/types";

export type Bridge = {
  post: (msg: ResponseMessage) => void;
  onMessage: <T extends RequestMessage["command"]>(
    command: T,
    handler: (msg: Extract<RequestMessage, { command: T }>) => void | Promise<void>
  ) => void;
  close: () => void;
};

export function createBridge(ws: WebSocket): Bridge {
  const handlers = new Map<string, (msg: RequestMessage) => void | Promise<void>>();

  ws.on("message", (data) => {
    let msg: RequestMessage;
    try {
      msg = JSON.parse(data.toString()) as RequestMessage;
    } catch {
      return;
    }
    const handler = handlers.get(msg.command);
    if (handler) void handler(msg);
  });

  return {
    post(msg: ResponseMessage) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    onMessage(command, handler) {
      handlers.set(command, handler as (msg: RequestMessage) => void | Promise<void>);
    },
    close() {
      ws.close();
    }
  };
}
