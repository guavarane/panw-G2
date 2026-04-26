import type { AudioFrame } from './stream'

export interface ImuSnapshot {
  x: number | null
  y: number | null
  z: number | null
  receivedAt: number
}

export interface DirectionEstimate {
  available: boolean
  label: string
  relativeAzimuthDeg: number | null
  confidence: number
  reason: string
  frameIndex: number
  channelCount: number
  micLevels: readonly number[]
  imu: ImuSnapshot | null
}

export interface DirectionEstimator {
  feed(frame: AudioFrame): DirectionEstimate
  getLatest(): DirectionEstimate | null
  getRecentBest(frameIndex: number, lookbackFrames?: number): DirectionEstimate | null
  updateImu(data: { x?: number; y?: number; z?: number }, receivedAt?: number): void
}

interface MicPosition {
  x: number
  y: number
}

export interface DirectionEstimatorOptions {
  minSignalRms?: number
  minConfidence?: number
  micLayout?: readonly MicPosition[]
}

const DEFAULT_MIC_LAYOUT: readonly MicPosition[] = [
  { x: -1, y: 1 },
  { x: 1, y: 1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
]
const HISTORY_LIMIT = 20

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeSignedDegrees(value: number): number {
  const normalized = ((((value + 180) % 360) + 360) % 360) - 180
  return normalized === -180 ? 180 : normalized
}

function labelForAzimuth(degrees: number): string {
  const labels = [
    'ahead',
    'front-right',
    'right',
    'back-right',
    'behind',
    'back-left',
    'left',
    'front-left',
  ]
  const unsigned = ((degrees % 360) + 360) % 360
  return labels[Math.round(unsigned / 45) % labels.length]
}

function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  return Math.sqrt(sumSq / samples.length)
}

function findOnsetIndex(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i])
    if (abs > peak) peak = abs
  }
  if (peak <= 0) return 0

  const threshold = peak * 0.5
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) return i
  }
  return 0
}

function createUnavailableEstimate(
  frame: AudioFrame,
  reason: string,
  micLevels: readonly number[],
  imu: ImuSnapshot | null,
): DirectionEstimate {
  return {
    available: false,
    label: 'unknown',
    relativeAzimuthDeg: null,
    confidence: 0,
    reason,
    frameIndex: frame.frameIndex,
    channelCount: frame.channelCount,
    micLevels,
    imu,
  }
}

export function createDirectionEstimator(
  opts: DirectionEstimatorOptions = {},
): DirectionEstimator {
  const minSignalRms = opts.minSignalRms ?? 0.003
  const minConfidence = opts.minConfidence ?? 0.2
  const micLayout = opts.micLayout ?? DEFAULT_MIC_LAYOUT
  const history: DirectionEstimate[] = []
  let latest: DirectionEstimate | null = null
  let latestImu: ImuSnapshot | null = null

  function remember(estimate: DirectionEstimate): DirectionEstimate {
    latest = estimate
    history.push(estimate)
    while (history.length > HISTORY_LIMIT) history.shift()
    return estimate
  }

  return {
    feed(frame) {
      const imu = latestImu ? { ...latestImu } : null

      if (frame.channelCount !== 4 || frame.channels.length < 4) {
        return remember(createUnavailableEstimate(frame, '4 mic stream missing', [], imu))
      }

      const micLevels = frame.channels.slice(0, 4).map(calculateRms)
      const averageLevel = micLevels.reduce((sum, level) => sum + level, 0) / micLevels.length
      if (averageLevel < minSignalRms) {
        return remember(createUnavailableEstimate(frame, 'signal too quiet', micLevels, imu))
      }

      let weightedX = 0
      let weightedY = 0
      let totalWeight = 0
      for (let i = 0; i < 4; i++) {
        const weight = micLevels[i]
        const position = micLayout[i] ?? DEFAULT_MIC_LAYOUT[i]
        weightedX += position.x * weight
        weightedY += position.y * weight
        totalWeight += weight
      }

      if (totalWeight <= 0) {
        return remember(createUnavailableEstimate(frame, 'no mic energy', micLevels, imu))
      }

      const onsets = frame.channels.slice(0, 4).map(findOnsetIndex)
      const leftOnset = (onsets[0] + onsets[2]) / 2
      const rightOnset = (onsets[1] + onsets[3]) / 2
      const frontOnset = (onsets[0] + onsets[1]) / 2
      const rearOnset = (onsets[2] + onsets[3]) / 2
      const timingWindowSamples = Math.max(4, Math.min(16, frame.channels[0].length * 0.04))
      const timingX = clamp((leftOnset - rightOnset) / timingWindowSamples, -1, 1)
      const timingY = clamp((rearOnset - frontOnset) / timingWindowSamples, -1, 1)
      const combinedX = weightedX / totalWeight + timingX * 0.35
      const combinedY = weightedY / totalWeight + timingY * 0.35

      const vectorStrength = Math.sqrt(combinedX * combinedX + combinedY * combinedY)
      const confidence = clamp(vectorStrength / 0.45)
      if (confidence < minConfidence) {
        const estimate = createUnavailableEstimate(frame, 'centered or unclear', micLevels, imu)
        return remember({ ...estimate, confidence })
      }

      const relativeAzimuthDeg = normalizeSignedDegrees(
        (Math.atan2(combinedX, combinedY) * 180) / Math.PI,
      )

      return remember({
        available: true,
        label: labelForAzimuth(relativeAzimuthDeg),
        relativeAzimuthDeg,
        confidence,
        reason: 'four-channel mic array',
        frameIndex: frame.frameIndex,
        channelCount: frame.channelCount,
        micLevels,
        imu,
      })
    },
    getLatest() {
      return latest
    },
    getRecentBest(frameIndex, lookbackFrames = 5) {
      const candidates = history.filter(
        estimate =>
          estimate.frameIndex <= frameIndex && frameIndex - estimate.frameIndex <= lookbackFrames,
      )
      if (candidates.length === 0) return latest
      return candidates.reduce((best, estimate) => {
        const bestScore = (best.available ? 1 : 0) + best.confidence
        const estimateScore = (estimate.available ? 1 : 0) + estimate.confidence
        return estimateScore > bestScore ? estimate : best
      })
    },
    updateImu(data, receivedAt = Date.now()) {
      const x = finiteOrNull(data.x)
      const y = finiteOrNull(data.y)
      const z = finiteOrNull(data.z)
      if (x === null && y === null && z === null) return
      latestImu = { x, y, z, receivedAt }
    },
  }
}
