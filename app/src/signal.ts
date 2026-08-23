/**
 * A very small observable value. The URL hash is the source of truth for view state; these
 * signals only carry loaded data and a handful of UI flags (theme, modal, toasts).
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';

export type Unsubscribe = () => void;

export class Signal<T> {
  private listeners = new Set<(v: T) => void>();
  private v: T;

  constructor(initial: T) {
    this.v = initial;
  }

  get value(): T {
    return this.v;
  }

  set value(next: T) {
    if (Object.is(next, this.v)) return;
    this.v = next;
    for (const l of [...this.listeners]) l(next);
  }

  /** Force listeners to run even when the reference is unchanged (mutated in place). */
  touch(): void {
    for (const l of [...this.listeners]) l(this.v);
  }

  subscribe(fn: (v: T) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function signal<T>(initial: T): Signal<T> {
  return new Signal(initial);
}

/** Lit reactive controller: re-render the host whenever any of the signals change. */
export class Watch implements ReactiveController {
  private subs: Unsubscribe[] = [];
  constructor(
    private host: ReactiveControllerHost,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private signals: Signal<any>[],
  ) {
    host.addController(this);
  }
  hostConnected(): void {
    this.subs = this.signals.map((s) => s.subscribe(() => this.host.requestUpdate()));
  }
  hostDisconnected(): void {
    for (const u of this.subs) u();
    this.subs = [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function watch(host: ReactiveControllerHost, ...signals: Signal<any>[]): Watch {
  return new Watch(host, signals);
}
