export type RpcUiDialogQueue = {
  enqueue<T>(showDialog: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined>;
};

/** Serializes dialog calls because pi's parent TUI can only display one at a time. */
export function createRpcUiDialogQueue(): RpcUiDialogQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(showDialog: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
      const result = tail.then(() => signal?.aborted ? undefined : showDialog());
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
