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
  smoothingWindowFrames?: number
  minStableFrames?: number
  minStableShare?: number
  switchMargin?: number
  holdFrames?: number
  micLayout?: readonly MicPosition[]
}

const DEFAULT_MIC_LAYOUT: readonly MicPosition[] = [
  { x: -1, y: 1 },
  { x: 1, y: 1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
]
const HISTORY_LIMIT = 20
const DEFAULT_SMOOTHING_WINDOW_FRAMES = 18
const DEFAULT_MIN_STABLE_FRAMES = 4
const DEFAULT_MIN_STABLE_SHARE = 0.32
const DEFAULT_SWITCH_MARGIN = 0.35
const DEFAULT_HOLD_FRAMES = 35
const SIDE_DEAD_ZONE_DEGREES = 10
const REAR_DEAD_ZONE_DEGREES = 172

interface DirectionVote {
  label: string
  score: number
  count: number
  x: number
  y: number
  latest: DirectionEstimate
}

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

function labelForSide(degrees: number): 'left' | 'right' | null {
  const absDegrees = Math.abs(degrees)
  if (absDegrees < SIDE_DEAD_ZONE_DEGREES || absDegrees > REAR_DEAD_ZONE_DEGREES) {
    return null
  }
  return degrees < 0 ? 'left' : 'right'
}

function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  return Math.sqrt(sumSq / samples.length)
}

function averageLevel(micLevels: readonly number[]): number {
  if (micLevels.length === 0) return 0
  return micLevels.reduce((sum, level) => sum + level, 0) / micLevels.length
}

function angleToUnitVector(degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180
  return { x: Math.sin(radians), y: Math.cos(radians) }
}

function scoreEstimate(
  estimate: DirectionEstimate,
  frameIndex: number,
  smoothingWindowFrames: number,
): number {
  const ageFrames = Math.max(0, frameIndex - estimate.frameIndex)
  const recency = clamp(1 - ageFrames / smoothingWindowFrames, 0.35, 1)
  return estimate.confidence * recency
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
  const minSignalRms = opts.minSignalRms ?? 0.00035
  const minConfidence = opts.minConfidence ?? 0.035
  const smoothingWindowFrames = opts.smoothingWindowFrames ?? DEFAULT_SMOOTHING_WINDOW_FRAMES
  const minStableFrames = opts.minStableFrames ?? DEFAULT_MIN_STABLE_FRAMES
  const minStableShare = opts.minStableShare ?? DEFAULT_MIN_STABLE_SHARE
  const switchMargin = opts.switchMargin ?? DEFAULT_SWITCH_MARGIN
  const holdFrames = opts.holdFrames ?? DEFAULT_HOLD_FRAMES
  const micLayout = opts.micLayout ?? DEFAULT_MIC_LAYOUT
  const history: DirectionEstimate[] = []
  let latestRaw: DirectionEstimate | null = null
  let latestStable: DirectionEstimate | null = null
  let lastStableFrame = -Infinity
  let latestImu: ImuSnapshot | null = null

  function rememberRaw(estimate: DirectionEstimate): DirectionEstimate {
    latestRaw = estimate
    history.push(estimate)
    while (history.length > HISTORY_LIMIT) history.shift()
    return estimate
  }

  function holdOrSettle(raw: DirectionEstimate): DirectionEstimate {
    if (
      latestStable?.available &&
      raw.frameIndex - lastStableFrame <= holdFrames
    ) {
      latestStable = {
        ...latestStable,
        confidence: latestStable.confidence * 0.96,
        reason: 'holding stable direction',
        frameIndex: raw.frameIndex,
        channelCount: raw.channelCount,
        micLevels: raw.micLevels,
        imu: raw.imu,
      }
      return latestStable
    }

    latestStable = raw.available
      ? {
          ...raw,
          available: false,
          label: 'unknown',
          relativeAzimuthDeg: null,
          confidence: 0,
          reason: 'settling direction',
        }
      : raw
    return latestStable
  }

  function stabilize(raw: DirectionEstimate): DirectionEstimate {
    const candidates = history.filter(
      estimate =>
        estimate.available &&
        estimate.relativeAzimuthDeg !== null &&
        raw.frameIndex - estimate.frameIndex < smoothingWindowFrames,
    )
    if (candidates.length < minStableFrames) return holdOrSettle(raw)

    const votes = new Map<string, DirectionVote>()
    let totalScore = 0

    for (const estimate of candidates) {
      const score = scoreEstimate(estimate, raw.frameIndex, smoothingWindowFrames)
      totalScore += score
      const vote = votes.get(estimate.label) ?? {
        label: estimate.label,
        score: 0,
        count: 0,
        x: 0,
        y: 0,
        latest: estimate,
      }
      const vector = angleToUnitVector(estimate.relativeAzimuthDeg ?? 0)
      vote.score += score
      vote.count++
      vote.x += vector.x * score
      vote.y += vector.y * score
      if (estimate.frameIndex > vote.latest.frameIndex) vote.latest = estimate
      votes.set(estimate.label, vote)
    }

    const ranked = [...votes.values()].sort((a, b) => b.score - a.score)
    const winner = ranked[0]
    if (!winner || totalScore <= 0) return holdOrSettle(raw)

    const currentScore = latestStable?.available
      ? votes.get(latestStable.label)?.score ?? 0
      : 0
    const winnerShare = winner.score / totalScore
    const switchIsWeak =
      latestStable?.available &&
      winner.label !== latestStable.label &&
      winner.score < currentScore * (1 + switchMargin)

    if (
      winner.count < minStableFrames ||
      winnerShare < minStableShare ||
      switchIsWeak
    ) {
      return holdOrSettle(raw)
    }

    const relativeAzimuthDeg = normalizeSignedDegrees(
      (Math.atan2(winner.x, winner.y) * 180) / Math.PI,
    )
    latestStable = {
      ...winner.latest,
      label: winner.label,
      relativeAzimuthDeg,
      confidence: clamp(winnerShare),
      reason: 'stable rolling vote',
      frameIndex: raw.frameIndex,
      channelCount: raw.channelCount,
      micLevels: raw.micLevels,
      imu: raw.imu,
    }
    lastStableFrame = raw.frameIndex
    return latestStable
  }

  return {
    feed(frame) {
      const imu = latestImu ? { ...latestImu } : null

      if (frame.channelCount !== 4 || frame.channels.length < 4) {
        const raw = rememberRaw(createUnavailableEstimate(frame, '4 mic stream missing', [], imu))
        return stabilize(raw)
      }

      const micLevels = frame.channels.slice(0, 4).map(calculateRms)
      if (averageLevel(micLevels) < minSignalRms) {
        const raw = rememberRaw(
          createUnavailableEstimate(frame, 'listening', micLevels, imu),
        )
        return stabilize(raw)
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
        const raw = rememberRaw(createUnavailableEstimate(frame, 'no mic energy', micLevels, imu))
        return stabilize(raw)
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
        const estimate = createUnavailableEstimate(frame, 'listening', micLevels, imu)
        const raw = rememberRaw({ ...estimate, confidence })
        return stabilize(raw)
      }

      const relativeAzimuthDeg = normalizeSignedDegrees(
        (Math.atan2(combinedX, combinedY) * 180) / Math.PI,
      )
      const sideLabel = labelForSide(relativeAzimuthDeg)
      if (!sideLabel) {
        const estimate = createUnavailableEstimate(frame, 'listening', micLevels, imu)
        const raw = rememberRaw({ ...estimate, confidence })
        return stabilize(raw)
      }

      const raw = rememberRaw({
        available: true,
        label: sideLabel,
        relativeAzimuthDeg,
        confidence,
        reason: 'four-channel mic array',
        frameIndex: frame.frameIndex,
        channelCount: frame.channelCount,
        micLevels,
        imu,
      })
      return stabilize(raw)
    },
    getLatest() {
      return latestStable ?? latestRaw
    },
    getRecentBest(frameIndex, lookbackFrames = 5) {
      if (
        latestStable &&
        latestStable.frameIndex <= frameIndex &&
        frameIndex - latestStable.frameIndex <= Math.max(lookbackFrames, holdFrames)
      ) {
        return latestStable
      }
      const candidates = history.filter(
        estimate =>
          estimate.frameIndex <= frameIndex && frameIndex - estimate.frameIndex <= lookbackFrames,
      )
      if (candidates.length === 0) return latestStable ?? latestRaw
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
