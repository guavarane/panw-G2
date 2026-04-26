import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export type FrameHandler = (samples: Float32Array, frameIndex: number) => void

export interface AudioStream {
  start(): Promise<void>
  stop(): Promise<void>
  onFrame(handler: FrameHandler): () => void
  getFrameCount(): number
}

function pcmToFloat32(pcmBytes: Uint8Array): Float32Array {
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)
  const sampleCount = pcmBytes.byteLength / 2
  const out = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

export function createAudioStream(bridge: EvenAppBridge): AudioStream {
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
        const samples = pcmToFloat32(pcm)
        for (const handler of handlers) handler(samples, frameCount)
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
