import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type WorkerSlot = { signal: AbortSignal; token: string; release(): void };
export type WorkerCoordinator = {
  endpoint: string;
  acquire(signal?: AbortSignal, depth?: number, parentToken?: string): Promise<WorkerSlot>;
  close(): Promise<void>;
};

type Lease = {
  socket: Socket;
  token: string;
  depth: number;
  parent?: Lease;
  active: boolean;
  pendingResume?: Socket;
};
type Request = { socket: Socket; depth: number; parent?: Lease; resume?: Lease };

function connectCommand(endpoint: string, command: string, signal?: AbortSignal): Promise<WorkerSlot> {
  if (signal?.aborted) return Promise.reject(new Error("Worker slot request cancelled"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const lost = new AbortController();
    let granted = false;
    let settled = false;
    let buffer = "";
    const cleanupPending = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      if (granted) lost.abort();
      else if (!settled) {
        settled = true;
        cleanupPending();
        reject(error);
      }
      socket.destroy();
    };
    const onAbort = () => fail(new Error("Worker slot request cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) {
        if (buffer.length > 128) fail(new Error("Invalid worker coordinator response"));
        return;
      }
      const match = /^granted ([0-9a-f-]{36})\n$/.exec(buffer);
      if (!match || granted) { fail(new Error("Invalid worker coordinator response")); return; }
      granted = true;
      settled = true;
      cleanupPending();
      resolve({ signal: lost.signal, token: match[1]!, release: () => socket.destroy() });
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => fail(new Error("Worker coordinator connection closed")));
  });
}

export function acquireWorkerSlot(
  endpoint: string,
  signal?: AbortSignal,
  depth = 1,
  parentToken?: string,
): Promise<WorkerSlot> {
  return connectCommand(endpoint, `acquire ${depth}${parentToken ? ` ${parentToken}` : ""}`, signal);
}

function control(endpoint: string, command: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Worker coordinator request cancelled"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("Worker coordinator request cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer === "ok\n") finish();
      else if (buffer.includes("\n") || buffer.length > 128) finish(new Error(buffer.trim() || "Invalid coordinator response"));
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Worker coordinator connection closed")));
  });
}

export function yieldWorkerSlot(endpoint: string, token: string, signal?: AbortSignal): Promise<void> {
  return control(endpoint, `yield ${token}`, signal);
}

export function resumeWorkerSlot(endpoint: string, token: string, signal?: AbortSignal): Promise<void> {
  return control(endpoint, `resume ${token}`, signal);
}

export async function createWorkerCoordinator(limits: {
  maxActive: number;
  maxLive: number;
  maxDepth?: 1 | 2;
}): Promise<WorkerCoordinator> {
  const maxDepth = limits.maxDepth ?? 2;
  if (!Number.isSafeInteger(limits.maxActive) || limits.maxActive < 1 ||
    !Number.isSafeInteger(limits.maxLive) || limits.maxLive < limits.maxActive ||
    (maxDepth === 2 && limits.maxLive < 2)) {
    throw new Error("Worker limits require 1 <= maxActive <= maxLive and maxLive >= 2 for nesting");
  }
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pi-delegate-${randomUUID()}`
    : join(tmpdir(), `pi-delegate-${randomUUID()}.sock`);
  const queue: Request[] = [];
  const sockets = new Set<Socket>();
  const leases = new Map<string, Lease>();
  let active = 0;
  let closing = false;
  const liveRootCount = () => [...leases.values()].filter((lease) => lease.depth === 1).length;
  const removeLease = (lease: Lease) => {
    if (!leases.has(lease.token)) return;
    for (const child of [...leases.values()]) if (child.parent === lease) child.socket.destroy();
    for (const request of [...queue]) if (request.parent === lease || request.resume === lease) request.socket.destroy();
    lease.pendingResume?.destroy();
    leases.delete(lease.token);
    if (lease.active) active--;
  };
  const drain = () => {
    if (closing) return;
    while (active < limits.maxActive) {
      const index = queue.findIndex((request) => {
        if (request.socket.destroyed) return false;
        if (request.resume) return leases.has(request.resume.token);
        if (leases.size >= limits.maxLive) return false;
        if (request.depth === 1 && maxDepth === 2 && liveRootCount() >= limits.maxLive - 1) return false;
        return !request.parent || leases.has(request.parent.token);
      });
      if (index < 0) break;
      const request = queue.splice(index, 1)[0]!;
      if (request.resume) {
        request.resume.active = true;
        request.resume.pendingResume = undefined;
        active++;
        request.socket.end("ok\n");
      } else {
        const lease: Lease = {
          socket: request.socket,
          token: randomUUID(),
          depth: request.depth,
          parent: request.parent,
          active: true,
        };
        leases.set(lease.token, lease);
        active++;
        request.socket.write(`granted ${lease.token}\n`);
      }
    }
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    let requested = false;
    socket.on("data", (chunk: Buffer) => {
      if (requested) { socket.destroy(); return; }
      buffer += chunk.toString("utf8");
      if (buffer.length > 128) { socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      requested = true;
      if (buffer.indexOf("\n") !== buffer.length - 1) { socket.destroy(); return; }
      const parts = buffer.trim().split(" ");
      if (parts[0] === "acquire") {
        const depth = Number(parts[1]);
        const parent = parts[2] ? leases.get(parts[2]) : undefined;
        if (!Number.isInteger(depth) || depth < 1 || depth > maxDepth ||
          (depth === 1 && (parts.length !== 2)) ||
          (depth > 1 && (!parent || parent.depth + 1 !== depth || parts.length !== 3))) {
          socket.end("invalid request\n"); return;
        }
        queue.push({ socket, depth, parent });
        drain();
      } else if (parts[0] === "yield" || parts[0] === "resume") {
        const lease = parts.length === 2 ? leases.get(parts[1]!) : undefined;
        if (!lease || (parts[0] === "yield" && !lease.active) ||
          (parts[0] === "resume" && (lease.active || lease.pendingResume))) {
          socket.end("invalid request\n"); return;
        }
        if (parts[0] === "yield") {
          lease.active = false;
          active--;
          socket.end("ok\n");
          drain();
        } else {
          lease.pendingResume = socket;
          queue.push({ socket, depth: lease.depth, resume: lease });
          drain();
        }
      } else socket.end("invalid request\n");
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      for (const lease of leases.values()) if (lease.socket === socket) removeLease(lease);
      const index = queue.findIndex((request) => request.socket === socket);
      if (index !== -1) {
        const [request] = queue.splice(index, 1);
        if (request?.resume) request.resume.pendingResume = undefined;
      }
      drain();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => { server.off("error", reject); resolve(); });
    });
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
  } catch (error) {
    server.close();
    if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
    throw error;
  }
  return {
    endpoint,
    acquire: (signal, depth = 1, parentToken) => acquireWorkerSlot(endpoint, signal, depth, parentToken),
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
    },
  };
}
