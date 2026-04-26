// Emits a SpikeEvent when the current RMS sustains above ratioThreshold * baseline
// for at least minDurationMs. Suppresses retriggers for cooldownMs after firing
// so a single loud event doesn't fire dozens of alerts.

const FRAME_INTERVAL_MS = 100
const BASELINE_FLOOR = 0.0005

export interface SpikeEvent {
  peakRms: number
  baselineRms: number
  ratio: number
  durationMs: number
  frameIndex: number
}

export interface SpikeDetectorOptions {
  ratioThreshold?: number
  minDurationMs?: number
  cooldownMs?: number
}

export interface SpikeDetector {
  feed(currentRms: number, baselineRms: number, frameIndex: number): SpikeEvent | null
}

export function createSpikeDetector(opts: SpikeDetectorOptions = {}): SpikeDetector {
  const ratioThreshold = opts.ratioThreshold ?? 2.5
  const minDurationMs = opts.minDurationMs ?? 150
  const cooldownMs = opts.cooldownMs ?? 1000

  let runStartFrame: number | null = null
  let runPeakRms = 0
  let lastFireFrame = -Infinity

  return {
    feed(currentRms, baselineRms, frameIndex) {
      const safeBaseline = Math.max(baselineRms, BASELINE_FLOOR)
      const ratio = currentRms / safeBaseline
      const inCooldown = (frameIndex - lastFireFrame) * FRAME_INTERVAL_MS < cooldownMs

      if (ratio < ratioThreshold) {
        runStartFrame = null
        runPeakRms = 0
        return null
      }

      if (runStartFrame === null) {
        runStartFrame = frameIndex
        runPeakRms = currentRms
      } else if (currentRms > runPeakRms) {
        runPeakRms = currentRms
      }

      const durationMs = (frameIndex - runStartFrame + 1) * FRAME_INTERVAL_MS
      if (durationMs < minDurationMs || inCooldown) return null

      const event: SpikeEvent = {
        peakRms: runPeakRms,
        baselineRms: safeBaseline,
        ratio: runPeakRms / safeBaseline,
        durationMs,
        frameIndex,
      }
      lastFireFrame = frameIndex
      runStartFrame = null
      runPeakRms = 0
      return event
    },
  }
}
