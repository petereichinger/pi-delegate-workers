export type WidgetRefresh<T> = {
  immediate(context: T): void;
  schedule(context: T): void;
  cancel(): void;
};

export function createWidgetRefresh<T>(
  render: (context: T) => void,
  intervalMs = 1_000,
  timing: {
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  } = {},
): WidgetRefresh<T> {
  const now = timing.now ?? Date.now;
  const setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> =
    timing.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = timing.clearTimer ?? clearTimeout;
  let lastRenderAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingContext: T | undefined;

  const flush = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    const context = pendingContext;
    pendingContext = undefined;
    if (context === undefined) return;
    lastRenderAt = now();
    render(context);
  };

  return {
    immediate(context) {
      pendingContext = context;
      flush();
    },
    schedule(context) {
      pendingContext = context;
      if (timer !== undefined) return;
      const delay = intervalMs - (now() - lastRenderAt);
      if (delay <= 0) flush();
      else timer = setTimer(flush, delay);
    },
    cancel() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      pendingContext = undefined;
    },
  };
}
