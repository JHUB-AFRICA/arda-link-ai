// Synthesized ringback tone — classic dual-tone phone ring (440 Hz + 480 Hz),
// 2 seconds on, 4 seconds off. Plays through Web Audio so we don't need an
// asset file and it stops instantly when we tell it to.

export class Ringback {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private ownsContext = false;

  /**
   * Start the ringback. If an AudioContext is passed in, the ringback shares
   * it (so playback starts immediately on the same gesture-unlocked context
   * the voice client uses). Otherwise we create our own.
   */
  start(sharedCtx?: AudioContext): void {
    if (!this.stopped) return;
    this.stopped = false;

    try {
      if (sharedCtx) {
        this.ctx = sharedCtx;
        this.ownsContext = false;
      } else {
        const AudioContextClass =
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext || window.AudioContext;
        this.ctx = new AudioContextClass();
        this.ownsContext = true;
      }

      // iOS / Safari: resume if suspended.
      if (this.ctx.state === "suspended") {
        void this.ctx.resume();
      }

      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.ctx.destination);

      this.oscA = this.ctx.createOscillator();
      this.oscA.type = "sine";
      this.oscA.frequency.value = 440;
      this.oscA.connect(this.gain);
      this.oscA.start();

      this.oscB = this.ctx.createOscillator();
      this.oscB.type = "sine";
      this.oscB.frequency.value = 480;
      this.oscB.connect(this.gain);
      this.oscB.start();

      this.scheduleRingPulses();
    } catch {
      // Web Audio failed — silently degrade (no ringback, call still works).
      this.stopped = true;
    }
  }

  /**
   * 2s on, 4s off, repeating. Uses gain ramps to avoid clicks at the edges.
   */
  private scheduleRingPulses(): void {
    if (this.stopped || !this.ctx || !this.gain) return;
    const now = this.ctx.currentTime;
    const g = this.gain.gain;
    // Ring up
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(0.12, now + 0.05);
    // Hold for ~1.9s
    g.setValueAtTime(0.12, now + 1.95);
    // Ring down
    g.linearRampToValueAtTime(0, now + 2.0);
    // Schedule the next cycle (2s ring + 4s silence = 6s)
    this.pulseTimer = setTimeout(() => this.scheduleRingPulses(), 6000);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }

    try {
      if (this.gain && this.ctx) {
        const now = this.ctx.currentTime;
        this.gain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(this.gain.gain.value, now);
        this.gain.gain.linearRampToValueAtTime(0, now + 0.08);
      }
    } catch {
      // ignore
    }

    // Tear down oscillators shortly after the fade.
    setTimeout(() => {
      try {
        this.oscA?.stop();
        this.oscB?.stop();
        this.oscA?.disconnect();
        this.oscB?.disconnect();
        this.gain?.disconnect();
      } catch {
        // ignore
      }
      this.oscA = null;
      this.oscB = null;
      this.gain = null;
      if (this.ownsContext && this.ctx) {
        void this.ctx.close().catch(() => undefined);
      }
      this.ctx = null;
    }, 120);
  }
}
