// OpenAI gpt-4o-audio-preview classifier. Given a 1-second audio clip, the
// model either transcribes the speech in it OR classifies the dominant
// non-speech sound — whichever applies. Returns a single JSON response.
//
// Why one call for both: speech and environmental sounds are both important
// for the deaf/hoh user. A bicycle bell is just as critical as someone saying
// "excuse me". Branching on type in the prompt keeps the round-trip count to
// one per spike, which is cheaper and lower-latency than separate Whisper +
// classification calls.
//
// API docs: https://platform.openai.com/docs/guides/audio

import type { SoundClass } from '../audio/classifier'
import { bytesToBase64, encodeWav } from '../audio/wav-encoder'

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const OPENAI_MODEL = 'gpt-4o-audio-preview'
const REQUEST_TIMEOUT_MS = 8000
const MIN_CALL_INTERVAL_MS = 1500

export interface OpenaiClassification {
  type: 'speech' | 'siren' | 'car_horn' | 'bicycle_bell' | 'vehicle' | 'footsteps' | 'animal' | 'impact' | 'other_sound'
  transcript?: string      // only present when type === 'speech'
  description?: string     // human label for non-speech (e.g. "ambulance siren")
  urgency: 'low' | 'medium' | 'high'
  confidence: number
}

export interface OpenaiClassifier {
  isAvailable(): boolean
  classify(samples: Float32Array): Promise<OpenaiClassification | null>
}

const SYSTEM_PROMPT = `You are an audio analyzer for accessibility software helping deaf and hard-of-hearing users be aware of nearby sounds and speech.

Listen to the attached audio clip and respond with JSON only — no commentary, no markdown.

DECISION RULE:
- If the audio contains clear human speech in any language: type = "speech", and put the exact words in "transcript"
- Otherwise: pick the closest type for the dominant sound, and put a short human label in "description"

Output schema:
{
  "type": "speech" | "siren" | "car_horn" | "bicycle_bell" | "vehicle" | "footsteps" | "animal" | "impact" | "other_sound",
  "transcript": "<exact words said>"  (REQUIRED if type is speech, otherwise omit),
  "description": "<3-30 char label>" (REQUIRED if type is NOT speech, otherwise omit),
  "urgency": "low" | "medium" | "high",
  "confidence": <number 0 to 1>
}

URGENCY GUIDE (this matters for deaf user safety):
- "high"   : sirens, alarms, car horns, screaming, glass breaking, anything signaling immediate safety
- "medium" : approaching vehicles, footsteps very close, persistent animal sounds, doorbells
- "low"    : casual speech, distant sounds, background ambience

EXAMPLES:
{"type":"speech","transcript":"excuse me","urgency":"low","confidence":0.95}
{"type":"siren","description":"ambulance siren","urgency":"high","confidence":0.92}
{"type":"car_horn","description":"car horn honking","urgency":"high","confidence":0.88}
{"type":"bicycle_bell","description":"bicycle bell","urgency":"medium","confidence":0.85}
{"type":"footsteps","description":"footsteps approaching","urgency":"medium","confidence":0.7}
{"type":"animal","description":"dog barking","urgency":"medium","confidence":0.8}
{"type":"other_sound","description":"hand clap","urgency":"low","confidence":0.6}

If unsure, set confidence below 0.5 and use type "other_sound".`

interface OpenaiResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string; type?: string }
}

export function createOpenaiClassifier(apiKey: string | undefined): OpenaiClassifier {
  const enabled = typeof apiKey === 'string' && apiKey.trim().length > 0
  let lastCallAt = 0

  return {
    isAvailable: () => enabled,

    async classify(samples) {
      if (!enabled) return null
      const now = Date.now()
      if (now - lastCallAt < MIN_CALL_INTERVAL_MS) {
        console.log('[openai] throttled — skipping classification')
        return null
      }
      lastCallAt = now

      const wavBytes = encodeWav(samples)
      const base64 = bytesToBase64(wavBytes)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      try {
        const response = await fetch(OPENAI_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: OPENAI_MODEL,
            modalities: ['text'],
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'user',
                content: [
                  { type: 'input_audio', input_audio: { data: base64, format: 'wav' } },
                ],
              },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          }),
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          console.warn(`[openai] http ${response.status}: ${body.slice(0, 200)}`)
          return null
        }

        const json = (await response.json()) as OpenaiResponse
        if (json.error) {
          console.warn(`[openai] api error: ${json.error.message ?? 'unknown'}`)
          return null
        }

        const text = json.choices?.[0]?.message?.content
        if (!text) {
          console.warn('[openai] empty response')
          return null
        }

        return parseClassification(text)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          console.warn('[openai] timeout')
        } else {
          console.warn('[openai] error:', err)
        }
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function parseClassification(text: string): OpenaiClassification | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    console.warn('[openai] non-JSON response:', text.slice(0, 200))
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const obj = parsed as Record<string, unknown>
  const validTypes: OpenaiClassification['type'][] = [
    'speech', 'siren', 'car_horn', 'bicycle_bell', 'vehicle', 'footsteps',
    'animal', 'impact', 'other_sound',
  ]
  const type = validTypes.includes(obj.type as OpenaiClassification['type'])
    ? (obj.type as OpenaiClassification['type'])
    : 'other_sound'

  const validUrgencies = ['low', 'medium', 'high'] as const
  type Urgency = typeof validUrgencies[number]
  const urgency: Urgency = validUrgencies.includes(obj.urgency as Urgency)
    ? (obj.urgency as Urgency)
    : 'low'

  const transcript = typeof obj.transcript === 'string' && obj.transcript.length > 0
    ? obj.transcript.slice(0, 200) : undefined
  const description = typeof obj.description === 'string' && obj.description.length > 0
    ? obj.description.slice(0, 50) : undefined

  return {
    type,
    transcript,
    description,
    urgency,
    confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
  }
}

// Maps the OpenAI-specific type taxonomy onto the project's existing
// SoundClass enum. We keep both because SoundClass is what the heuristic
// uses and what the rest of the code expects; the OpenAI type is richer.
export function openaiTypeToSoundClass(type: OpenaiClassification['type']): SoundClass {
  switch (type) {
    case 'speech': return 'voice'
    case 'footsteps': return 'footsteps'
    case 'vehicle':
    case 'car_horn': return 'vehicle'
    case 'siren':
    case 'bicycle_bell': return 'bell'
    case 'animal':
    case 'impact':
    case 'other_sound':
    default:
      return 'other'
  }
}
