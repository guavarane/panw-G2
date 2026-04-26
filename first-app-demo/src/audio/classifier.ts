// Heuristic sound classifier. Given a slice of audio samples around a spike,
// extracts spectral features (FFT-based) and applies hand-tuned rules to label
// the sound as voice / footsteps / vehicle / bell / other.
//
// This is NOT a trained model. The rules are best-effort heuristics chosen
// from typical spectral signatures:
//   - Voice/speech: mid-range centroid (500-2500 Hz), formant energy in mid band
//   - Footsteps:    very low centroid (<400 Hz), low-band energy dominant
//   - Vehicle:      low-mid centroid (300-800 Hz), broadband sustained
//   - Bell/whistle: high centroid (>2500 Hz), high ZCR, narrow tonal peak
//   - Other:        anything that doesn't match
//
// Expect ~50-70% accuracy on real-world audio. Fine for a hackathon
// demo — we surface confidence so the UI can hedge low-confidence labels.

import { fft, hannWindow } from './fft'

const SAMPLE_RATE = 16000
const FFT_SIZE = 2048   // ~128 ms window at 16 kHz; balance of resolution vs cost
const NYQUIST = SAMPLE_RATE / 2

export type SoundClass = 'voice' | 'footsteps' | 'vehicle' | 'bell' | 'other'

export interface ClassifierFeatures {
  spectralCentroidHz: number
  spectralRolloff85Hz: number
  zeroCrossingRate: number   // 0-1, fraction of samples where sign changes
  bandEnergies: { low: number; lowMid: number; mid: number; high: number }
  totalEnergy: number
}

export interface Classification {
  className: SoundClass
  confidence: number   // 0-1, rough self-rating
  features: ClassifierFeatures
}

export interface Classifier {
  classify(samples: Float32Array): Classification
}

export function createClassifier(): Classifier {
  const window = hannWindow(FFT_SIZE)
  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)

  function computeFeatures(samples: Float32Array): ClassifierFeatures {
    // Use the most recent FFT_SIZE samples; pad with zeros if shorter
    re.fill(0)
    im.fill(0)
    const offset = Math.max(0, samples.length - FFT_SIZE)
    const copyLen = Math.min(FFT_SIZE, samples.length)
    for (let i = 0; i < copyLen; i++) {
      re[i] = samples[offset + i] * window[i]
    }
    fft(re, im)

    // Magnitude spectrum (only need positive frequencies)
    const halfSize = FFT_SIZE >> 1
    const mag = new Float32Array(halfSize)
    let totalEnergy = 0
    for (let k = 0; k < halfSize; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      totalEnergy += mag[k]
    }

    // Spectral centroid: weighted-average frequency
    let weightedSum = 0
    for (let k = 0; k < halfSize; k++) {
      const freq = (k * SAMPLE_RATE) / FFT_SIZE
      weightedSum += freq * mag[k]
    }
    const spectralCentroidHz = totalEnergy > 0 ? weightedSum / totalEnergy : 0

    // Spectral rolloff @ 85%: frequency below which 85% of energy lies
    let cumulativeEnergy = 0
    const rolloffThreshold = totalEnergy * 0.85
    let rolloffBin = halfSize - 1
    for (let k = 0; k < halfSize; k++) {
      cumulativeEnergy += mag[k]
      if (cumulativeEnergy >= rolloffThreshold) {
        rolloffBin = k
        break
      }
    }
    const spectralRolloff85Hz = (rolloffBin * SAMPLE_RATE) / FFT_SIZE

    // Band energies — sum mag in each band
    const bandRanges: Array<[number, number, keyof ClassifierFeatures['bandEnergies']]> = [
      [20, 250, 'low'],
      [250, 800, 'lowMid'],
      [800, 3000, 'mid'],
      [3000, NYQUIST, 'high'],
    ]
    const bandEnergies = { low: 0, lowMid: 0, mid: 0, high: 0 }
    for (const [loHz, hiHz, name] of bandRanges) {
      const loBin = Math.floor((loHz / SAMPLE_RATE) * FFT_SIZE)
      const hiBin = Math.min(halfSize, Math.ceil((hiHz / SAMPLE_RATE) * FFT_SIZE))
      let bandSum = 0
      for (let k = loBin; k < hiBin; k++) bandSum += mag[k]
      bandEnergies[name] = bandSum
    }

    // Zero-crossing rate over the full input window (not just the FFT slice)
    let crossings = 0
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) crossings++
    }
    const zeroCrossingRate = samples.length > 1 ? crossings / (samples.length - 1) : 0

    return {
      spectralCentroidHz,
      spectralRolloff85Hz,
      zeroCrossingRate,
      bandEnergies,
      totalEnergy,
    }
  }

  function applyRules(f: ClassifierFeatures): Classification {
    const { spectralCentroidHz: centroid, zeroCrossingRate: zcr, bandEnergies: be } = f
    const total = be.low + be.lowMid + be.mid + be.high
    const lowFrac = total > 0 ? be.low / total : 0
    const midFrac = total > 0 ? (be.lowMid + be.mid) / total : 0
    const highFrac = total > 0 ? be.high / total : 0

    // Bell / whistle / squeak: high centroid + high ZCR + high-band dominant
    if (centroid > 2500 && zcr > 0.12 && highFrac > 0.25) {
      return { className: 'bell', confidence: 0.7, features: f }
    }

    // Footsteps: very low centroid, low-band dominant, brief transient
    if (centroid < 500 && lowFrac > 0.45) {
      return { className: 'footsteps', confidence: 0.6, features: f }
    }

    // Voice: mid centroid, mid bands dominant, moderate ZCR
    if (centroid >= 400 && centroid < 2500 && midFrac > 0.5 && zcr > 0.02 && zcr < 0.18) {
      return { className: 'voice', confidence: 0.65, features: f }
    }

    // Vehicle: low-mid centroid with broadband (no single band dominant)
    if (centroid >= 200 && centroid < 1000 && lowFrac < 0.6 && highFrac < 0.2) {
      return { className: 'vehicle', confidence: 0.5, features: f }
    }

    return { className: 'other', confidence: 0.3, features: f }
  }

  return {
    classify(samples) {
      const features = computeFeatures(samples)
      return applyRules(features)
    },
  }
}
