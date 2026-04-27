import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export type MicChannelCount = 1 | 4

export interface AudioFrame {
  samples: Float32Array
  channels: Float32Array[]
  channelCount: MicChannelCount
  frameIndex: number
  byteLength: number
  receivedAt: number
}

export interface AudioStreamOptions {
  channelCount?: MicChannelCount | 'auto'
}

export type FrameHandler = (frame: AudioFrame) => void

export interface AudioStream {
  start(): Promise<void>
  stop(): Promise<void>
  onFrame(handler: FrameHandler): () => void
  getFrameCount(): number
}

const SAMPLE_RATE_HZ = 16_000
const EXPECTED_FRAME_MS = 100
const EXPECTED_MONO_SAMPLES = (SAMPLE_RATE_HZ * EXPECTED_FRAME_MS) / 1000

function detectChannelCount(sampleCount: number, mode: MicChannelCount | 'auto'): MicChannelCount {
  if (mode !== 'auto') return sampleCount % mode === 0 ? mode : 1
  return sampleCount >= EXPECTED_MONO_SAMPLES * 3.5 && sampleCount % 4 === 0 ? 4 : 1
}

function decodePcmFrame(
  pcmBytes: Uint8Array,
  frameIndex: number,
  mode: MicChannelCount | 'auto',
): AudioFrame {
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)
  const sampleCount = pcmBytes.byteLength / 2
  const channelCount = detectChannelCount(sampleCount, mode)

  if (channelCount === 1) {
    const samples = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768
    }
    return {
      samples,
      channels: [samples],
      channelCount,
      frameIndex,
      byteLength: pcmBytes.byteLength,
      receivedAt: Date.now(),
    }
  }

  const perChannelSamples = sampleCount / channelCount
  const channels = Array.from({ length: channelCount }, () => new Float32Array(perChannelSamples))
  const samples = new Float32Array(perChannelSamples)

  for (let i = 0; i < sampleCount; i++) {
    const value = view.getInt16(i * 2, true) / 32768
    const channelIndex = i % channelCount
    const sampleIndex = Math.floor(i / channelCount)
    channels[channelIndex][sampleIndex] = value
    samples[sampleIndex] += value / channelCount
  }

  return {
    samples,
    channels,
    channelCount,
    frameIndex,
    byteLength: pcmBytes.byteLength,
    receivedAt: Date.now(),
  }
}

export function createAudioStream(
  bridge: EvenAppBridge,
  opts: AudioStreamOptions = {},
): AudioStream {
  const channelMode = opts.channelCount ?? 'auto'
  const handlers = new Set<FrameHandler>()
  let frameCount = 0
  let unsubscribe: (() => void) | null = null

  return {
    async start() {
      if (unsubscribe) return
      unsubscribe = bridge.onEvenHubEvent(event => {
        const pcm = event.audioEvent?.audioPcm
        if (!pcm) return
        frameCount++
        const frame = decodePcmFrame(pcm, frameCount, channelMode)
        for (const handler of handlers) handler(frame)
      })
      await bridge.audioControl(true)
    },
    async stop() {
      await bridge.audioControl(false)
      unsubscribe?.()
      unsubscribe = null
    },
    onFrame(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    getFrameCount: () => frameCount,
  }
}
