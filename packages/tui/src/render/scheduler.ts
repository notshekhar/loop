import { performance } from "node:perf_hooks";

/** One frame per ~60Hz tick: more is wasted work, the terminal can't show it. */
const MIN_RENDER_INTERVAL_MS = 16;

/**
 * Decides WHEN a frame is drawn: coalesces many requests into one frame,
 * throttles to one frame per tick, and lets latency-sensitive input jump the
 * queue.
 */
export class RenderScheduler {
    private requested = false;
    private immediateScheduled = false;
    private timer: NodeJS.Timeout | undefined;
    private lastRenderAt = 0;

    /** `isStopped` is read at every fire, so a frame queued before stop() never draws. */
    constructor(
        private readonly render: () => void,
        private readonly isStopped: () => boolean,
    ) {}

    /** Draw right now, dropping anything queued. */
    renderNow(): void {
        this.requested = false;
        this.cancel();
        this.draw();
    }

    /** Ask for a frame on the next throttled tick. Repeated calls coalesce. */
    request(): void {
        if (this.requested) return;
        this.requested = true;
        process.nextTick(() => this.schedule());
    }

    /** Ask for a frame on the next microtask turn, skipping the throttle. */
    requestImmediate(): void {
        this.cancel();
        this.requested = true;
        if (this.immediateScheduled) return;
        this.immediateScheduled = true;
        process.nextTick(() => {
            this.immediateScheduled = false;
            if (this.isStopped() || !this.requested) return;
            // A previously queued schedule() can create a timer before this
            // callback runs. User input must preempt that throttled frame.
            this.cancel();
            this.requested = false;
            this.draw();
        });
    }

    cancel(): void {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule(): void {
        if (this.isStopped() || this.timer || !this.requested) return;
        const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - (performance.now() - this.lastRenderAt));
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.isStopped() || !this.requested) return;
            this.requested = false;
            this.draw();
            if (this.requested) this.schedule();
        }, delay);
    }

    private draw(): void {
        this.lastRenderAt = performance.now();
        this.render();
    }
}
