export type DelegationTaskState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type DelegationWaitMode = "available" | "next" | "all";

export type DelegationTaskSnapshot<T, R> = {
  id: string;
  batchId: string;
  task: T;
  state: DelegationTaskState;
  result?: R;
};

export type DelegationBatchSnapshot<T, R> = {
  id: string;
  tasks: DelegationTaskSnapshot<T, R>[];
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  undelivered: number;
  terminal: boolean;
};

export type DelegationResults<T, R> = {
  batch: DelegationBatchSnapshot<T, R>;
  results: R[];
  timedOut: boolean;
  interrupted: boolean;
};

type ManagedTask<T, R> = DelegationTaskSnapshot<T, R> & {
  delivered: boolean;
  abortController?: AbortController;
};

type Batch<T, R> = {
  id: string;
  tasks: ManagedTask<T, R>[];
  completions: ManagedTask<T, R>[];
  waiters: Set<() => void>;
};

export type DelegationSessionOptions<T, R> = {
  maxWorkers: number;
  runTask: (task: T, id: string, signal: AbortSignal) => Promise<R>;
  classifyResult: (result: R) => "completed" | "failed" | "cancelled";
  createCancelledResult: (task: T, id: string) => R;
  createFailedResult: (task: T, id: string, error: unknown) => R;
  onStateChange?: (task: DelegationTaskSnapshot<T, R>) => void;
};

export class DelegationSession<T, R> {
  readonly #options: DelegationSessionOptions<T, R>;
  readonly #batches = new Map<string, Batch<T, R>>();
  readonly #tasks = new Map<string, ManagedTask<T, R>>();
  readonly #queue: ManagedTask<T, R>[] = [];
  #nextBatchId = 1;
  #nextWorkerId = 1;
  #running = 0;
  #shuttingDown = false;

  constructor(options: DelegationSessionOptions<T, R>) {
    if (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1) {
      throw new Error("maxWorkers must be a positive integer");
    }
    this.#options = options;
  }

  createBatch(tasks: T[]): DelegationBatchSnapshot<T, R> {
    if (this.#shuttingDown) throw new Error("Delegation session is shutting down");
    if (tasks.length === 0) throw new Error("A delegation batch requires at least one task");

    const batch: Batch<T, R> = {
      id: `b${this.#nextBatchId++}`,
      tasks: [],
      completions: [],
      waiters: new Set(),
    };
    this.#batches.set(batch.id, batch);
    this.#enqueue(batch, tasks);
    this.#pump();
    return this.#snapshot(batch);
  }

  addTasks(batchId: string, tasks: T[]): DelegationBatchSnapshot<T, R> {
    if (this.#shuttingDown) throw new Error("Delegation session is shutting down");
    if (tasks.length === 0) throw new Error("At least one task is required");
    const batch = this.#requireBatch(batchId);
    this.#enqueue(batch, tasks);
    this.#pump();
    return this.#snapshot(batch);
  }

  getBatch(batchId: string): DelegationBatchSnapshot<T, R> {
    return this.#snapshot(this.#requireBatch(batchId));
  }

  listBatches(): DelegationBatchSnapshot<T, R>[] {
    return [...this.#batches.values()].map((batch) => this.#snapshot(batch));
  }

  async getResults(
    batchId: string,
    waitFor: DelegationWaitMode = "available",
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<DelegationResults<T, R>> {
    const batch = this.#requireBatch(batchId);
    let timedOut = false;
    let interrupted = false;

    if (!this.#waitCondition(batch, waitFor)) {
      const waitResult = await this.#waitForChange(batch, waitFor, options);
      timedOut = waitResult === "timeout";
      interrupted = waitResult === "interrupted";
    }

    const results: R[] = [];
    for (const task of batch.completions) {
      if (task.result !== undefined && !task.delivered) {
        task.delivered = true;
        results.push(task.result);
      }
    }

    return { batch: this.#snapshot(batch), results, timedOut, interrupted };
  }

  cancelWorker(workerId: string): boolean {
    const task = this.#tasks.get(workerId);
    if (!task || this.#isTerminal(task.state)) return false;

    if (task.state === "queued") {
      const queueIndex = this.#queue.indexOf(task);
      if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
      task.result = this.#options.createCancelledResult(task.task, task.id);
      task.state = "cancelled";
      this.#requireBatch(task.batchId).completions.push(task);
      this.#notify(task);
      this.#notifyBatch(task.batchId);
      return true;
    }

    if (!task.abortController || task.abortController.signal.aborted) return false;
    task.abortController.abort();
    return true;
  }

  cancelBatch(batchId: string): number {
    const batch = this.#requireBatch(batchId);
    let cancelled = 0;
    for (const task of batch.tasks) {
      if (this.cancelWorker(task.id)) cancelled++;
    }
    return cancelled;
  }

  shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const batch of this.#batches.values()) {
      for (const task of batch.tasks) {
        if (!this.#isTerminal(task.state)) this.cancelWorker(task.id);
      }
      this.#wakeWaiters(batch);
    }
  }

  #enqueue(batch: Batch<T, R>, tasks: T[]): void {
    for (const input of tasks) {
      const task: ManagedTask<T, R> = {
        id: `w${this.#nextWorkerId++}`,
        batchId: batch.id,
        task: input,
        state: "queued",
        delivered: false,
      };
      batch.tasks.push(task);
      this.#tasks.set(task.id, task);
      this.#queue.push(task);
      this.#notify(task);
    }
    this.#wakeWaiters(batch);
  }

  #pump(): void {
    while (!this.#shuttingDown && this.#running < this.#options.maxWorkers) {
      const task = this.#queue.shift();
      if (!task) return;
      if (task.state !== "queued") continue;

      const abortController = new AbortController();
      task.abortController = abortController;
      task.state = "running";
      this.#running++;
      this.#notify(task);

      void this.#options.runTask(task.task, task.id, abortController.signal)
        .then((result) => {
          task.result = result;
          task.state = this.#options.classifyResult(result);
        })
        .catch((error) => {
          const cancelled = abortController.signal.aborted;
          task.result = cancelled
            ? this.#options.createCancelledResult(task.task, task.id)
            : this.#options.createFailedResult(task.task, task.id, error);
          task.state = cancelled ? "cancelled" : "failed";
        })
        .finally(() => {
          task.abortController = undefined;
          this.#running--;
          this.#requireBatch(task.batchId).completions.push(task);
          this.#notify(task);
          this.#notifyBatch(task.batchId);
          this.#pump();
        });
    }
  }

  #waitCondition(batch: Batch<T, R>, waitFor: DelegationWaitMode): boolean {
    if (waitFor === "available") return true;
    if (waitFor === "all") return batch.tasks.every((task) => this.#isTerminal(task.state));
    return batch.tasks.some((task) => task.result !== undefined && !task.delivered) ||
      batch.tasks.every((task) => this.#isTerminal(task.state));
  }

  #waitForChange(
    batch: Batch<T, R>,
    waitFor: DelegationWaitMode,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<"ready" | "timeout" | "interrupted"> {
    if (options.signal?.aborted) return Promise.resolve("interrupted");

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: "ready" | "timeout" | "interrupted") => {
        batch.waiters.delete(check);
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const check = () => {
        if (this.#waitCondition(batch, waitFor) || this.#shuttingDown) finish("ready");
      };
      const abort = () => finish("interrupted");

      batch.waiters.add(check);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => finish("timeout"), Math.max(0, options.timeoutMs));
      }
      check();
    });
  }

  #snapshot(batch: Batch<T, R>): DelegationBatchSnapshot<T, R> {
    const counts = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of batch.tasks) counts[task.state]++;
    return {
      id: batch.id,
      tasks: batch.tasks.map(({ delivered: _delivered, abortController: _abortController, ...task }) => ({ ...task })),
      ...counts,
      undelivered: batch.tasks.filter((task) => task.result !== undefined && !task.delivered).length,
      terminal: batch.tasks.every((task) => this.#isTerminal(task.state)),
    };
  }

  #notify(task: ManagedTask<T, R>): void {
    this.#options.onStateChange?.({
      id: task.id,
      batchId: task.batchId,
      task: task.task,
      state: task.state,
      result: task.result,
    });
  }

  #notifyBatch(batchId: string): void {
    const batch = this.#batches.get(batchId);
    if (batch) this.#wakeWaiters(batch);
  }

  #wakeWaiters(batch: Batch<T, R>): void {
    for (const waiter of [...batch.waiters]) waiter();
  }

  #requireBatch(batchId: string): Batch<T, R> {
    const batch = this.#batches.get(batchId);
    if (!batch) throw new Error(`Delegation batch not found: ${batchId}`);
    return batch;
  }

  #isTerminal(state: DelegationTaskState): boolean {
    return state === "completed" || state === "failed" || state === "cancelled";
  }
}
