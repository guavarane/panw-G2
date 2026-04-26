// Tracks rolling RMS (loudness) of each audio frame and an exponentially-weighted
// moving average baseline of "what the room normally sounds like." Spike detection
// compares current RMS to baseline to decide whether the wearer should be alerted.
//
// Each audio frame is 100 ms (1600 samples at 16 kHz). The baseline half-life is
// configurable via constructor options; default 10 s means brief spikes barely
// move the baseline but sustained noise gradually adapts to it.

const FRAME_INTERVAL_MS = 100
const BASELINE_FLOOR = 0.0005

export interface RmsTracker {
  push(samples: Float32Array): void
  getCurrent(): number
  getBaseline(): number
  getRatio(): number
}

export function createRmsTracker(opts: { baselineHalfLifeSeconds?: number } = {}): RmsTracker {
  const halfLife = opts.baselineHalfLifeSeconds ?? 10
  // Per-frame EMA alpha derived from desired half-life
  const alpha = 1 - Math.pow(0.5, FRAME_INTERVAL_MS / 1000 / halfLife)

  let currentRms = 0
  let baselineRms = BASELINE_FLOOR
  let initialized = false

  return {
    push(samples) {
      let sumSq = 0
      for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
      currentRms = Math.sqrt(sumSq / samples.length)
      if (!initialized) {
        baselineRms = Math.max(currentRms, BASELINE_FLOOR)
        initialized = true
      } else {
        baselineRms = alpha * currentRms + (1 - alpha) * baselineRms
        if (baselineRms < BASELINE_FLOOR) baselineRms = BASELINE_FLOOR
      }
    },
    getCurrent: () => currentRms,
    getBaseline: () => baselineRms,
    getRatio: () => currentRms / Math.max(baselineRms, BASELINE_FLOOR),
  }
}
