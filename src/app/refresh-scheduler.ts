import type { AppContext, AppModule } from '@/app/app-context';
import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/runtime';

export interface RefreshRegistration {
  name: string;
  fn: () => Promise<boolean | void>;
  intervalMs: number;
  condition?: () => boolean;
}

export class RefreshScheduler implements AppModule {
  private ctx: AppContext;
  private refreshRunners = new Map<string, { loop: SmartPollLoopHandle; intervalMs: number }>();
  private flushTimeoutIds = new Set<ReturnType<typeof setTimeout>>();
  private hiddenSince = 0;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {}

  destroy(): void {
    for (const timeoutId of this.flushTimeoutIds) {
      clearTimeout(timeoutId);
    }
    this.flushTimeoutIds.clear();
    for (const { loop } of this.refreshRunners.values()) {
      loop.stop();
    }
    this.refreshRunners.clear();
  }

  setHiddenSince(ts: number): void {
    this.hiddenSince = ts;
  }

  getHiddenSince(): number {
    return this.hiddenSince;
  }

  scheduleRefresh(
    name: string,
    fn: () => Promise<boolean | void>,
    intervalMs: number,
    condition?: () => boolean
  ): void {
    const HIDDEN_REFRESH_MULTIPLIER = 10;
    const JITTER_FRACTION = 0.1;
    const MIN_REFRESH_MS = 1000;
    // Max effective interval: intervalMs * 4 (backoff) * 10 (hidden) = 40x base
    const MAX_BACKOFF_MULTIPLIER = 4;

    let currentMultiplier = 1;

    const computeDelay = (baseMs: number, isHidden: boolean) => {
      const adjusted = baseMs * (isHidden ? HIDDEN_REFRESH_MULTIPLIER : 1);
      const jitterRange = adjusted * JITTER_FRACTION;
      const jittered = adjusted + (Math.random() * 2 - 1) * jitterRange;
      return Math.max(MIN_REFRESH_MS, Math.round(jittered));
    };
    const scheduleNext = (delay: number) => {
      if (this.ctx.isDestroyed) return;
      const timeoutId = setTimeout(run, delay);
      this.refreshTimeoutIds.set(name, timeoutId);
    };
    const run = async () => {
      if (this.ctx.isDestroyed) return;
      const isHidden = document.visibilityState === 'hidden';
      if (isHidden) {
        scheduleNext(computeDelay(intervalMs * currentMultiplier, true));
        return;
      }
      if (condition && !condition()) {
        scheduleNext(computeDelay(intervalMs * currentMultiplier, false));
        return;
      }
      if (this.ctx.inFlight.has(name)) {
        scheduleNext(computeDelay(intervalMs * currentMultiplier, false));
        return;
      }
      this.ctx.inFlight.add(name);
      try {
        const changed = await fn();
        if (changed === false) {
          currentMultiplier = Math.min(currentMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
        } else {
          currentMultiplier = 1;
        }
      } catch (e) {
        console.error(`[App] Refresh ${name} failed:`, e);
        currentMultiplier = 1;
      } finally {
        this.ctx.inFlight.delete(name);
        scheduleNext(computeDelay(intervalMs * currentMultiplier, false));
      }
    }, {
      intervalMs,
      // De-escalate global refresh loops in background tabs to cut API volume.
      hiddenMultiplier: 10,
      refreshOnVisible: false,
      runImmediately: false,
      maxBackoffMultiplier: 4,
      onError: (e) => {
        console.error(`[App] Refresh ${name} failed:`, e);
      },
    });

    this.refreshRunners.set(name, { loop, intervalMs });
  }

  flushStaleRefreshes(): void {
    if (!this.hiddenSince) return;
    const hiddenMs = Date.now() - this.hiddenSince;
    this.hiddenSince = 0;

    for (const timeoutId of this.flushTimeoutIds) {
      clearTimeout(timeoutId);
    }
    this.flushTimeoutIds.clear();

    let stagger = 0;
    for (const { loop, intervalMs } of this.refreshRunners.values()) {
      if (hiddenMs < intervalMs) continue;
      const delay = stagger;
      stagger += 150;
      const timeoutId = setTimeout(() => {
        this.flushTimeoutIds.delete(timeoutId);
        loop.trigger();
      }, delay);
      this.flushTimeoutIds.add(timeoutId);
    }
  }

  registerAll(registrations: RefreshRegistration[]): void {
    for (const reg of registrations) {
      this.scheduleRefresh(reg.name, reg.fn, reg.intervalMs, reg.condition);
    }
  }
}
