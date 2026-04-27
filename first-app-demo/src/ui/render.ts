import { TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { DirectionEstimate } from '../audio/direction'
import type { AppState } from '../state/machine'
import {
  LEFT_RADAR_CONTAINER_ID,
  LEFT_RADAR_CONTAINER_NAME,
  RIGHT_RADAR_CONTAINER_ID,
  RIGHT_RADAR_CONTAINER_NAME,
} from './containers'

export type RadarSide = 'left' | 'right' | null

export interface RadarSignal {
  side: RadarSide
  intensity: number
}

const PULSE_MS = 900
const BASELINE_FLOOR = 0.0005
const BLANK_RADAR = ' '

const ARROW_FRAMES: Record<Exclude<RadarSide, null>, string[]> = {
  left: [
    [' ', ' ', '   <', '  <<<', '   <', ' ', ' '].join('\n'),
    [' ', '  <', ' <<<', '<<<<<', ' <<<', '  <', ' '].join('\n'),
    ['  <', ' <<<', '<<<<<', '<<<<<<<', '<<<<<', ' <<<', '  <'].join('\n'),
  ],
  right: [
    [' ', ' ', '>   ', '>>> ', '>   ', ' ', ' '].join('\n'),
    [' ', '>  ', '>>> ', '>>>>>', '>>> ', '>  ', ' '].join('\n'),
    ['>  ', '>>> ', '>>>>>', '>>>>>>>', '>>>>>', '>>> ', '>  '].join('\n'),
  ],
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function sideFromDirection(estimate: DirectionEstimate | null): RadarSide {
  if (!estimate?.available) return null
  if (estimate.label !== 'left' && estimate.label !== 'right') return null
  return estimate.label
}

export function radarSignalFromState(
  state: AppState,
  currentRms: number,
  baselineRms: number,
  direction: DirectionEstimate | null = null,
): RadarSignal {
  if (state.kind === 'ALERTING') {
    return {
      side: sideFromDirection(state.spike.direction),
      intensity: clamp(state.spike.ratio / 5),
    }
  }

  return {
    side: sideFromDirection(direction),
    intensity: clamp(currentRms / Math.max(baselineRms, BASELINE_FLOOR) / 4),
  }
}

function activeArrowContent(side: Exclude<RadarSide, null>, intensity: number): string {
  const pulsePhase = (Date.now() % PULSE_MS) / PULSE_MS
  const frames = ARROW_FRAMES[side]
  const pulseIndex = Math.min(
    frames.length - 1,
    Math.floor(pulsePhase * frames.length),
  )
  if (intensity < 0.25) return frames[Math.min(pulseIndex, 1)]
  return frames[pulseIndex]
}

export class RadarRenderer {
  private inFlight = false
  private lastRenderAt = 0
  private pendingSignal: RadarSignal | null = null
  private leftContent = ''
  private rightContent = ''

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly minIntervalMs = 250,
  ) {}

  async initialize(): Promise<void> {
    await this.updateSide('left', BLANK_RADAR)
    await this.updateSide('right', BLANK_RADAR)
  }

  render(signal: RadarSignal, force = false): void {
    if (!force) {
      const now = Date.now()
      if (now - this.lastRenderAt < this.minIntervalMs || this.inFlight) {
        this.pendingSignal = signal
        return
      }
    } else if (this.inFlight) {
      this.pendingSignal = signal
      return
    }
    void this.dispatch(signal)
  }

  private async dispatch(signal: RadarSignal): Promise<void> {
    this.inFlight = true
    this.lastRenderAt = Date.now()
    try {
      await this.applySignal(signal)
    } finally {
      this.inFlight = false
      const pending = this.pendingSignal
      if (pending) {
        this.pendingSignal = null
        void this.dispatch(pending)
      }
    }
  }

  private async applySignal(signal: RadarSignal): Promise<void> {
    const left = signal.side === 'left' ? activeArrowContent('left', signal.intensity) : BLANK_RADAR
    const right =
      signal.side === 'right' ? activeArrowContent('right', signal.intensity) : BLANK_RADAR

    if (left !== this.leftContent) await this.updateSide('left', left)
    if (right !== this.rightContent) await this.updateSide('right', right)
  }

  private async updateSide(side: Exclude<RadarSide, null>, content: string): Promise<void> {
    const ok = await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: side === 'left' ? LEFT_RADAR_CONTAINER_ID : RIGHT_RADAR_CONTAINER_ID,
        containerName: side === 'left' ? LEFT_RADAR_CONTAINER_NAME : RIGHT_RADAR_CONTAINER_NAME,
        content,
        contentOffset: 0,
        contentLength: 0,
      }),
    )

    if (ok) {
      if (side === 'left') this.leftContent = content
      else this.rightContent = content
    } else {
      console.warn(`[clearpath] radar text update failed (${side})`)
    }
  }
}
