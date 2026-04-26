// Watches RMS for ~2 seconds after a spike fires to decide whether the source
// is *approaching* (RMS keeps growing) vs. transient (RMS fades). The verdict
// is fed back into the state machine so the alert text can escalate from
// "SOUND DETECTED" to "APPROACHING".
//
// "Approaching" is defined as: the loudest sample seen during the watch window
// is at least 1.2x the spike's original peak. That 20% growth threshold is
// loose enough to catch real approach (someone walking toward you) but tight
// enough to avoid false positives from a single late-window noise.

const FRAME_INTERVAL_MS = 100
const WATCH_DURATION_MS = 2000
const APPROACH_GROWTH_RATIO = 1.2

export interface ApproachVerdict {
  approaching: boolean
  spikePeakRms: number
  watchPeakRms: number
  growth: number
}

export interface ApproachDetector {
  startWatch(spikePeakRms: number, frameIndex: number): void
  feed(currentRms: number, frameIndex: number): ApproachVerdict | null
  isWatching(): boolean
  cancel(): void
}

export function createApproachDetector(): ApproachDetector {
  let watchStartFrame: number | null = null
  let spikePeakRms = 0
  let watchPeakRms = 0

  function reset() {
    watchStartFrame = null
    spikePeakRms = 0
    watchPeakRms = 0
  }

  return {
    startWatch(peakRms, frameIndex) {
      watchStartFrame = frameIndex
      spikePeakRms = peakRms
      watchPeakRms = peakRms
    },
    feed(currentRms, frameIndex) {
      if (watchStartFrame === null) return null
      if (currentRms > watchPeakRms) watchPeakRms = currentRms
      const elapsedMs = (frameIndex - watchStartFrame) * FRAME_INTERVAL_MS
      if (elapsedMs < WATCH_DURATION_MS) return null

      const growth = watchPeakRms / Math.max(spikePeakRms, 0.0001)
      const verdict: ApproachVerdict = {
        approaching: growth >= APPROACH_GROWTH_RATIO,
        spikePeakRms,
        watchPeakRms,
        growth,
      }
      reset()
      return verdict
    },
    isWatching: () => watchStartFrame !== null,
    cancel: reset,
  }
}
