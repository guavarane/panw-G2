// Circular buffer of recent audio samples. The spike detector tells us *that*
// something interesting happened, but it triggers in the middle of the audio —
// the classifier needs to look back at the surrounding samples to compute
// spectral features. This buffer holds the most recent ~1 second of audio so
// we can grab a slice on demand.

const SAMPLE_RATE = 16000

export interface SampleBuffer {
  push(samples: Float32Array): void
  getRecent(durationMs: number): Float32Array
  available(): number
}

export function createSampleBuffer(maxDurationMs = 1000): SampleBuffer {
  const capacity = Math.ceil((maxDurationMs / 1000) * SAMPLE_RATE)
  const buffer = new Float32Array(capacity)
  let writeIndex = 0
  let totalWritten = 0

  return {
    push(samples) {
      for (let i = 0; i < samples.length; i++) {
        buffer[writeIndex] = samples[i]
        writeIndex = (writeIndex + 1) % capacity
      }
      totalWritten += samples.length
    },
    getRecent(durationMs) {
      const wanted = Math.ceil((durationMs / 1000) * SAMPLE_RATE)
      const available = Math.min(totalWritten, capacity, wanted)
      const out = new Float32Array(available)
      const startIdx = ((writeIndex - available) % capacity + capacity) % capacity
      for (let i = 0; i < available; i++) {
        out[i] = buffer[(startIdx + i) % capacity]
      }
      return out
    },
    available: () => Math.min(totalWritten, capacity),
  }
}
