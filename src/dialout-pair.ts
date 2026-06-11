// pair_complete waiting logic for EdgeBookDialoutClient (spec-135).
// Extracted to its own module to keep dialout.ts under the 500-code-line gate.

export interface PairCompleteResult {
  device_id: string;
  label: string;
}

// Holds the pending waiter for a single pair_complete frame. Only one active
// wait is expected at a time (one pair_register per dial-out session).
export class PairCompleteWaiter {
  private resolve: ((r: PairCompleteResult | null) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Called by EdgeBookDialoutClient.handleMessage when type === "pair_complete".
  onFrame(frame: { device_id?: string; label?: string }): void {
    if (!this.resolve) return;
    const cb = this.resolve;
    this.resolve = null;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    cb({ device_id: frame.device_id ?? "", label: frame.label ?? "" });
  }

  // Wait up to ttlMs for a pair_complete frame from the host.
  // Returns null on timeout — old-host degradation (spec-135 §C.2).
  wait(ttlMs: number): Promise<PairCompleteResult | null> {
    return new Promise<PairCompleteResult | null>((resolve) => {
      this.resolve = resolve;
      this.timer = setTimeout(() => {
        if (this.resolve) { this.resolve = null; resolve(null); }
        this.timer = null;
      }, ttlMs);
    });
  }
}
