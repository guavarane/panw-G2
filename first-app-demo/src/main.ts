import './styles.css'
import {
  OsEventTypeList,
  StartUpPageCreateResult,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { createAudioStream } from './audio/stream'
import { createRmsTracker } from './audio/rms'
import { createSpikeDetector } from './audio/spike-detector'
import { createApproachDetector } from './audio/approach-detector'
import { createSampleBuffer } from './audio/buffer'
import { createClassifier, type Classification } from './audio/classifier'
import { createOpenaiClassifier, openaiTypeToSoundClass } from './llm/openai-classifier'
import { createLlmClassifier } from './llm/gemini-classifier'
import { buildStartupPage } from './ui/containers'
import { Renderer, renderState } from './ui/render'
import { createStateMachine } from './state/machine'

const bridgeStatusEl = document.querySelector<HTMLElement>('#bridge-status')
const pageStatusEl = document.querySelector<HTMLElement>('#page-status')
const detailEl = document.querySelector<HTMLElement>('#detail')

function setText(el: HTMLElement | null, text: string) {
  if (el) el.textContent = text
}

async function main() {
  setText(bridgeStatusEl, 'Waiting')
  setText(detailEl, 'Connecting to Even Hub bridge...')

  const bridge = await waitForEvenAppBridge()
  setText(bridgeStatusEl, 'Ready')

  const result = await bridge.createStartUpPageContainer(buildStartupPage('[*] starting...'))
  if (result !== StartUpPageCreateResult.success) {
    setText(pageStatusEl, `Failed (${result})`)
    setText(detailEl, `createStartUpPageContainer returned ${result}`)
    throw new Error(`page create failed (${result})`)
  }
  setText(pageStatusEl, 'OK')
  setText(detailEl, 'ClearPath listening — display is on glasses simulator/hardware.')

  const rms = createRmsTracker({ baselineHalfLifeSeconds: 10 })
  // Tuned to catch short transients like footsteps (which were missed at 2.5x/150ms).
  // 1.8x for one full frame (100 ms) is loose enough for a single footstep impact
  // but strict enough to avoid triggering on breathing or keyboard typing.
  const spikes = createSpikeDetector({
    ratioThreshold: 1.8,
    minDurationMs: 100,
    cooldownMs: 800,
  })
  const approach = createApproachDetector()
  // Keep 4 s of audio so a delayed LLM call can grab a 2.5 s window AFTER
  // the spike fires (lets full phrases like "excuse me, I'm on your left"
  // finish before we send to the model).
  const sampleBuffer = createSampleBuffer(4000)
  const classifier = createClassifier()
  // OpenAI is preferred (handles speech transcription + sound classification in one call).
  // Gemini is the fallback if OpenAI key is missing — same role but classification-only.
  const openaiClassifier = createOpenaiClassifier(import.meta.env.VITE_OPENAI_API_KEY)
  const geminiClassifier = createLlmClassifier(import.meta.env.VITE_GEMINI_API_KEY)
  const llmActive = openaiClassifier.isAvailable() ? 'OpenAI' : geminiClassifier.isAvailable() ? 'Gemini (fallback)' : 'none (heuristic only)'
  console.log(`[clearpath] LLM classifier: ${llmActive}`)
  const fsm = createStateMachine()
  const renderer = new Renderer(bridge, 200)
  const audio = createAudioStream(bridge)

  audio.onFrame((samples, frameIndex) => {
    rms.push(samples)
    sampleBuffer.push(samples)
    const spike = spikes.feed(rms.getCurrent(), rms.getBaseline(), frameIndex)
    if (spike) {
      const classification = classifier.classify(sampleBuffer.getRecent(500))
      console.log(
        `[clearpath] SPIKE frame=${spike.frameIndex} ratio=${spike.ratio.toFixed(2)} peak=${spike.peakRms.toFixed(4)} dur=${spike.durationMs}ms`,
      )
      console.log(
        `[clearpath] CLASS[heuristic] ${classification.className} (conf=${classification.confidence.toFixed(2)}) ` +
        `centroid=${classification.features?.spectralCentroidHz.toFixed(0)}Hz ` +
        `zcr=${classification.features?.zeroCrossingRate.toFixed(3)}`
      )
      fsm.alert(spike, classification)
      approach.startWatch(spike.peakRms, frameIndex)

      // Fire-and-forget LLM classification — upgrades the alert label when it returns.
      // We wait ~1.5 s after the spike to let the user finish speaking the
      // sentence (e.g. "excuse me, I'm on your left" takes ~2.2 s); then we
      // grab the trailing 2.5 s of audio so the model gets the full phrase
      // including ~1 s of pre-spike context.
      // OpenAI handles both speech transcription and sound classification in one call.
      // Gemini fallback is classification-only.
      const SPIKE_TO_LLM_DELAY_MS = 1500
      const LLM_AUDIO_WINDOW_MS = 2500
      const startLlm = (): Promise<Classification | null> => {
        const audioForLlm = sampleBuffer.getRecent(LLM_AUDIO_WINDOW_MS)
        return openaiClassifier.isAvailable()
        ? openaiClassifier.classify(audioForLlm).then(result => {
            if (!result) return null
            const classification: Classification = {
              className: openaiTypeToSoundClass(result.type),
              confidence: result.confidence,
              source: 'llm',
              description: result.description,
              transcript: result.transcript,
              urgency: result.urgency,
            }
            console.log(
              `[clearpath] CLASS[openai] type=${result.type} ` +
              (result.transcript ? `transcript="${result.transcript}" ` : `description="${result.description}" `) +
              `urgency=${result.urgency} conf=${result.confidence.toFixed(2)}`
            )
            return classification
          })
        : geminiClassifier.isAvailable()
        ? geminiClassifier.classify(audioForLlm).then(result => {
            if (!result) return null
            console.log(
              `[clearpath] CLASS[gemini] ${result.className} "${result.description}" ` +
              `conf=${result.confidence.toFixed(2)} urgency=${result.urgency}`
            )
            return {
              className: result.className,
              confidence: result.confidence,
              source: 'llm',
              description: result.description,
              urgency: result.urgency,
            } as Classification
          })
        : Promise.resolve(null)
      }

      setTimeout(() => {
        startLlm().then(classification => {
          if (!classification) return
          // Apply to whatever alert is currently active. With rapid-fire events
          // (claps, footsteps) every new spike replaces the alert; we still
          // want the LLM upgrade to land on the active alert since adjacent
          // spikes are usually the same sound.
          const currentState = fsm.current()
          if (currentState.kind !== 'ALERTING') {
            console.log('[clearpath] LLM result arrived but alert already cleared — discarding')
            return
          }
          fsm.attachClassification(classification)
        }).catch(err => console.warn('[clearpath] LLM classify failed:', err))
      }, SPIKE_TO_LLM_DELAY_MS)
    }
    const verdict = approach.feed(rms.getCurrent(), frameIndex)
    if (verdict) {
      console.log(
        `[clearpath] APPROACH verdict approaching=${verdict.approaching} growth=${verdict.growth.toFixed(2)}x (spike=${verdict.spikePeakRms.toFixed(4)} watch=${verdict.watchPeakRms.toFixed(4)})`,
      )
      if (verdict.approaching) fsm.upgradeToApproaching()
    }
    if (frameIndex % 50 === 0) {
      console.log(
        `[clearpath] frame=${frameIndex} rms=${rms.getCurrent().toFixed(4)} baseline=${rms.getBaseline().toFixed(4)} state=${fsm.current().kind}`,
      )
    }
    renderer.render(renderState(fsm.current(), rms.getCurrent(), rms.getBaseline()))
  })

  fsm.onChange(state => {
    console.log(`[clearpath] state -> ${state.kind}`)
    renderer.render(renderState(state, rms.getCurrent(), rms.getBaseline()), true)
  })

  // Periodic tick for ALERTING auto-clear (4s)
  setInterval(() => fsm.tick(Date.now()), 250)

  await audio.start()
  console.log('[clearpath] audio capture started')

  // Double-tap to exit (works whether the event arrives via sysEvent or textEvent)
  bridge.onEvenHubEvent(async event => {
    const sysType = event.sysEvent?.eventType ?? null
    const textType = event.textEvent?.eventType ?? null
    if (
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      textType === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      await audio.stop()
      bridge.shutDownPageContainer(1)
    }
  })
}

main().catch(err => {
  console.error('[clearpath] fatal:', err)
  setText(detailEl, err instanceof Error ? err.message : String(err))
})
