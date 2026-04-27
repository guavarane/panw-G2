// Encode Float32 PCM samples to a self-contained WAV byte array, then to base64
// for inline upload to multimodal LLM APIs (Gemini, GPT-4o, etc.).
//
// WAV is the simplest universally-accepted container — a 44-byte RIFF header
// followed by raw 16-bit little-endian PCM. No compression, no metadata. We
// downcast Float32 [-1, 1] to Int16 [-32768, 32767] losslessly within audible
// dynamic range.

const SAMPLE_RATE = 16000

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const bytesPerSample = 2
  const numChannels = 1
  const dataLength = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)

  // RIFF header
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(view, 8, 'WAVE')

  // fmt chunk
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)               // PCM chunk size
  view.setUint16(20, 1, true)                // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true)  // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true)               // block align
  view.setUint16(34, 8 * bytesPerSample, true)                         // bits per sample

  // data chunk
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataLength, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF
    view.setInt16(offset, int16, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

export function bytesToBase64(bytes: Uint8Array): string {
  // btoa() handles up to ~ASCII range, so we feed it byte-as-charCode.
  let binary = ''
  const chunkSize = 0x8000  // 32 KB chunks to avoid call-stack limits on big buffers
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + chunkSize))
    binary += String.fromCharCode.apply(null, Array.from(chunk) as unknown as number[])
  }
  return btoa(binary)
}
