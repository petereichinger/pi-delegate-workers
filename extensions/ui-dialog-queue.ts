export type RpcUiDialogQueue = {
  enqueue<T>(showDialog: () => Promise<T>): Promise<T>;
};

/** Serializes dialog calls because pi's parent TUI can only display one at a time. */
export function createRpcUiDialogQueue(): RpcUiDialogQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(showDialog: () => Promise<T>): Promise<T> {
      const result = tail.then(showDialog);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
