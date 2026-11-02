/**
 * Tracks which sidebar view is current. VS Code may resolve a new view (for example after the container
 * is moved) before or after the old one is disposed, so every async flow remembers the view it started
 * in and drops its result if that view is no longer the current one.
 */
export class ViewHolder<V> {
  private current: V | undefined;

  set(view: V): void {
    this.current = view;
  }

  get(): V | undefined {
    return this.current;
  }

  isCurrent(view: V | undefined): boolean {
    return view !== undefined && this.current === view;
  }

  /** Called when a view is disposed. Returns true only if it was the current view (and is now cleared). */
  release(view: V): boolean {
    if (this.current !== view) {
      return false;
    }
    this.current = undefined;
    return true;
  }
}

/**
 * Ordered, at-least-until-delivered message queue for one view. `postMessage` resolves to false when the
 * webview could not take the message (for example while it is hidden), so a message stays at the head of
 * the queue until the host reports it delivered, then is removed: nothing is lost, nothing is sent twice,
 * and order is kept. A message is never delivered to a view that is no longer current.
 * Types listed in `coalesce` are state snapshots: only the latest one needs to be delivered.
 */
export class Outbox<M extends { type: string }> {
  private queue: M[] = [];
  private flushing = false;
  private retry = false;
  private closed = false;

  constructor(
    private readonly send: (message: M) => PromiseLike<boolean>,
    private readonly alive: () => boolean,
    private readonly coalesce: ReadonlySet<string> = new Set()
  ) {}

  post(message: M): void {
    if (this.closed || !this.alive()) {
      return;
    }
    if (this.coalesce.has(message.type)) {
      this.queue = this.queue.filter((queued) => queued.type !== message.type);
    }
    this.queue.push(message);
    void this.flush();
  }

  /** Delivers queued messages in order; stops at the first one the webview does not accept. */
  async flush(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.flushing) {
      this.retry = true; // asked again (for example: the view was shown) while a send was in flight
      return;
    }
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        if (!this.alive()) {
          this.close();
          return;
        }
        const head = this.queue[0];
        let delivered: boolean;
        try {
          delivered = await this.send(head);
        } catch {
          this.close(); // posting to a disposed webview throws
          return;
        }
        if (this.closed) {
          return;
        }
        if (!delivered) {
          if (this.retry) {
            this.retry = false;
            continue; // the view may have become visible during the send: try the same message again
          }
          return;
        }
        this.retry = false;
        const at = this.queue.indexOf(head); // may have been superseded by a newer snapshot while in flight
        if (at >= 0) {
          this.queue.splice(at, 1);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Drops everything undelivered: the view was disposed or replaced. */
  close(): void {
    this.closed = true;
    this.queue = [];
  }

  get pending(): number {
    return this.queue.length;
  }
}
