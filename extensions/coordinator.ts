import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type WorkerSlot = { signal: AbortSignal; release(): void };
export type WorkerCoordinator = {
  endpoint: string;
  acquire(signal?: AbortSignal): Promise<WorkerSlot>;
  close(): Promise<void>;
};

export function acquireWorkerSlot(endpoint: string, signal?: AbortSignal): Promise<WorkerSlot> {
  if (signal?.aborted) return Promise.reject(new Error("Worker slot request cancelled"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const lost = new AbortController();
    let granted = false;
    let settled = false;
    let buffer = "";
    const cleanupPending = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      if (granted) {
        lost.abort();
      } else if (!settled) {
        settled = true;
        cleanupPending();
        reject(error);
      }
      socket.destroy();
    };
    const onAbort = () => fail(new Error("Worker slot request cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.on("connect", () => socket.write("acquire\n"));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) {
        if (buffer.length > 128) fail(new Error("Invalid worker coordinator response"));
        return;
      }
      if (buffer.slice(0, buffer.indexOf("\n")) !== "granted" || granted) {
        fail(new Error("Invalid worker coordinator response"));
        return;
      }
      granted = true;
      settled = true;
      cleanupPending();
      resolve({ signal: lost.signal, release: () => socket.destroy() });
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => fail(new Error("Worker coordinator connection closed")));
  });
}

export async function createWorkerCoordinator(limits: {
  maxActive: number;
  maxLive: number;
}): Promise<WorkerCoordinator> {
  if (!Number.isSafeInteger(limits.maxActive) || limits.maxActive < 1 ||
    !Number.isSafeInteger(limits.maxLive) || limits.maxLive < limits.maxActive) {
    throw new Error("Worker limits require 1 <= maxActive <= maxLive");
  }
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pi-delegate-${randomUUID()}`
    : join(tmpdir(), `pi-delegate-${randomUUID()}.sock`);
  const queue: Socket[] = [];
  const sockets = new Set<Socket>();
  const active = new Set<Socket>();
  let closing = false;
  const drain = () => {
    while (!closing && active.size < limits.maxActive && active.size < limits.maxLive && queue.length > 0) {
      const socket = queue.shift()!;
      if (socket.destroyed) continue;
      active.add(socket);
      socket.write("granted\n");
    }
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    let requested = false;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer === "acquire\n" && !requested) {
        requested = true;
        queue.push(socket);
        drain();
      } else if (buffer.length > 128 || buffer.includes("\n")) {
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      active.delete(socket);
      const index = queue.indexOf(socket);
      if (index !== -1) queue.splice(index, 1);
      drain();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
  } catch (error) {
    server.close();
    if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
    throw error;
  }
  return {
    endpoint,
    acquire: (signal) => acquireWorkerSlot(endpoint, signal),
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
    },
  };
}
