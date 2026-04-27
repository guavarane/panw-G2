// In-place radix-2 Cooley-Tukey FFT. ~50 lines, no dependencies. Operates on
// pre-allocated real/imag Float32Array pairs. Length must be a power of 2.
//
// We use this to turn a window of audio samples into a magnitude spectrum,
// which lets the classifier compute spectral centroid, band energies, etc.

export function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length
  if (n !== imag.length) throw new Error('fft: real/imag length mismatch')
  if ((n & (n - 1)) !== 0) throw new Error('fft: length must be a power of 2')

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tmpRe = real[i]; real[i] = real[j]; real[j] = tmpRe
      const tmpIm = imag[i]; imag[i] = imag[j]; imag[j] = tmpIm
    }
  }

  // Butterflies
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1
    const tableStep = (-2 * Math.PI) / size
    for (let block = 0; block < n; block += size) {
      for (let j = block, k = 0; j < block + halfSize; j++, k++) {
        const angle = tableStep * k
        const cosA = Math.cos(angle)
        const sinA = Math.sin(angle)
        const reTwiddle = real[j + halfSize] * cosA - imag[j + halfSize] * sinA
        const imTwiddle = real[j + halfSize] * sinA + imag[j + halfSize] * cosA
        real[j + halfSize] = real[j] - reTwiddle
        imag[j + halfSize] = imag[j] - imTwiddle
        real[j] += reTwiddle
        imag[j] += imTwiddle
      }
    }
  }
}

// Hann window — multiply samples by this before FFT to reduce spectral leakage.
// Pre-compute once and reuse for repeated FFTs of the same size.
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  }
  return w
}
