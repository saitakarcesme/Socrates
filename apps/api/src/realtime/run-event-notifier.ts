export class RunEventNotifier {
  private readonly subscribers = new Map<string, Set<() => void>>();

  publish(runId: string): void {
    const listeners = this.subscribers.get(runId);
    if (!listeners) return;

    for (const listener of [...listeners]) {
      listener();
    }
  }

  wait(runId: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();

    return new Promise((resolve) => {
      const listeners = this.subscribers.get(runId) ?? new Set<() => void>();
      this.subscribers.set(runId, listeners);

      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        listeners.delete(finish);
        if (listeners.size === 0) this.subscribers.delete(runId);
        resolve();
      };

      listeners.add(finish);
      const timer = setTimeout(finish, timeoutMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
