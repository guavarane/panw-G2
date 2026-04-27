// LLM-based sound classifier using Gemini 2.5 Flash. Sends a short audio clip
// (the ~1 s around a spike) to the model and asks for a structured JSON
// classification. Returns a richer label than the local heuristic (e.g.,
// "bicycle bell" instead of just "bell"), at the cost of ~1 s network latency.
//
// Designed to run AFTER the local heuristic has already shown an alert, so the
// LLM result is a progressive enhancement — if the network call fails or
// times out, the alert keeps showing the heuristic label.
//
// API docs: https://ai.google.dev/gemini-api/docs/audio

import type { SoundClass } from '../audio/classifier'
import { bytesToBase64, encodeWav } from '../audio/wav-encoder'

const GEMINI_MODEL = 'gemini-2.5-flash'
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
const REQUEST_TIMEOUT_MS = 5000
const MIN_CALL_INTERVAL_MS = 1200   // throttle so a burst of spikes doesn't hammer the API

export interface LlmClassification {
  className: SoundClass
  description: string
  confidence: number
  urgency: 'low' | 'medium' | 'high'
}

export interface LlmClassifier {
  isAvailable(): boolean
  classify(samples: Float32Array): Promise<LlmClassification | null>
}

const SYSTEM_PROMPT = `You are an environmental audio classifier for accessibility software helping deaf and hard-of-hearing users be aware of nearby sounds.

Identify the dominant sound in the attached audio clip and respond with JSON only.

Three categories:
- "voice": any human speech
- "bell": tonal attention-getting alerts — whistles, bicycle bells, doorbells, smoke alarms, sirens, car horns, phone ringtones
- "other": everything else (footsteps, claps, animals, vehicles, ambient noise)

Rules:
- "description" is a 3-30 character human label (e.g. "bicycle bell", "car horn", "dog barking", "person speaking")
- "urgency": high = immediate safety (sirens, horns, screaming); medium = doorbells, footsteps nearby; low = casual / distant
- Be terse — no markdown, no extra text

Output schema:
{
  "category": "voice" | "bell" | "other",
  "description": "<3-30 chars>",
  "confidence": <number 0-1>,
  "urgency": "low" | "medium" | "high"
}`

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
  }>
  error?: { message?: string; status?: string }
}

export function createLlmClassifier(apiKey: string | undefined): LlmClassifier {
  const enabled = typeof apiKey === 'string' && apiKey.trim().length > 0
  let lastCallAt = 0

  return {
    isAvailable: () => enabled,

    async classify(samples) {
      if (!enabled) return null
      const now = Date.now()
      if (now - lastCallAt < MIN_CALL_INTERVAL_MS) {
        console.log('[gemini] throttled — skipping classification')
        return null
      }
      lastCallAt = now

      const wavBytes = encodeWav(samples)
      const base64 = bytesToBase64(wavBytes)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      try {
        const response = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey!)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { inline_data: { mime_type: 'audio/wav', data: base64 } },
                  { text: SYSTEM_PROMPT },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2,
            },
          }),
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          console.warn(`[gemini] http ${response.status}: ${body.slice(0, 200)}`)
          return null
        }

        const json = (await response.json()) as GeminiResponse
        if (json.error) {
          console.warn(`[gemini] api error: ${json.error.message ?? 'unknown'}`)
          return null
        }

        const text = json.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) {
          console.warn('[gemini] empty response')
          return null
        }

        return parseClassification(text)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          console.warn('[gemini] timeout')
        } else {
          console.warn('[gemini] error:', err)
        }
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function parseClassification(text: string): LlmClassification | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    console.warn('[gemini] non-JSON response:', text.slice(0, 200))
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const obj = parsed as Record<string, unknown>
  const category = obj.category
  const description = obj.description
  const confidence = obj.confidence
  const urgency = obj.urgency

  // Gemini's prompt asks for the 3 categories, but it sometimes returns
  // older labels — coerce them to one of the 3.
  const incoming = String(category ?? '').toLowerCase()
  const className: SoundClass =
    incoming === 'speech' || incoming === 'voice' ? 'voice' :
    incoming === 'whistle_bell' || incoming === 'bell' || incoming === 'whistle' || incoming === 'siren' || incoming === 'alarm' || incoming === 'horn' ? 'bell' :
    'other'

  const validUrgencies = ['low', 'medium', 'high'] as const
  type Urgency = typeof validUrgencies[number]
  const safeUrgency: Urgency = validUrgencies.includes(urgency as Urgency)
    ? (urgency as Urgency)
    : 'low'

  return {
    className,
    description: typeof description === 'string' ? description.slice(0, 40) : 'sound',
    confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0.5,
    urgency: safeUrgency,
  }
}
