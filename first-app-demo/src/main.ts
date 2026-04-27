import './styles.css'
import {
  ImuReportPace,
  OsEventTypeList,
  StartUpPageCreateResult,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { createDirectionEstimator } from './audio/direction'
import { createAudioStream } from './audio/stream'
import { createRmsTracker } from './audio/rms'
import { createSpikeDetector } from './audio/spike-detector'
import { createApproachDetector } from './audio/approach-detector'
import { createSampleBuffer } from './audio/buffer'
import { createClassifier, type Classification } from './audio/classifier'
import { createOpenaiClassifier, openaiTypeToSoundClass } from './llm/openai-classifier'
import { createLlmClassifier } from './llm/gemini-classifier'
import { buildStartupPage } from './ui/containers'
import { RadarRenderer, radarSignalFromState } from './ui/render'
import { createStateMachine } from './state/machine'

const bridgeStatusEl = document.querySelector<HTMLElement>('#bridge-status')
const pageStatusEl = document.querySelector<HTMLElement>('#page-status')
const detailEl = document.querySelector<HTMLElement>('#detail')

function setText(el: HTMLElement | null, text: string) {
  if (el) el.textContent = text
}

async function createStartupPage(bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>) {
  const page = buildStartupPage()
  let result = await bridge.createStartUpPageContainer(page)
  if (result === StartUpPageCreateResult.success) return result

  console.warn(`[clearpath] startup page create failed (${result}); shutting down stale page and retrying`)
  await bridge.shutDownPageContainer(1).catch(err => {
    console.warn('[clearpath] stale page shutdown failed before retry:', err)
  })
  await new Promise(resolve => setTimeout(resolve, 300))

  result = await bridge.createStartUpPageContainer(page)
  return result
}

async function main() {
  setText(bridgeStatusEl, 'Waiting')
  setText(detailEl, 'Connecting to Even Hub bridge...')

  const bridge = await waitForEvenAppBridge()
  setText(bridgeStatusEl, 'Ready')

  const result = await createStartupPage(bridge)
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
  // Henry's glasses-tested values (1.6x / 1000 ms cooldown) — slightly more
  // sensitive than the laptop-sim tuning (1.8x / 800 ms) because the G2's
  // chassis-mounted mic is farther from sounds than a laptop deck mic.
  const spikes = createSpikeDetector({
    ratioThreshold: 1.6,
    minDurationMs: 100,
    cooldownMs: 1000,
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
  const renderer = new RadarRenderer(bridge, 250)
  const audio = createAudioStream(bridge, { channelCount: 4 })
  const direction = createDirectionEstimator({
    minSignalRms: 0.00035,
    minConfidence: 0.015,
    smoothingWindowFrames: 18,
    minStableFrames: 4,
    minStableShare: 0.32,
    switchMargin: 0.35,
    holdFrames: 35,
  })
  let unsubscribeEvents: (() => void) | null = null
  let loggedAudioShape = false
  let stoppingSensors = false

  async function stopSensors() {
    if (stoppingSensors) return
    stoppingSensors = true
    const unsubscribe = unsubscribeEvents
    unsubscribeEvents = null
    unsubscribe?.()
    await Promise.allSettled([
      audio.stop(),
      // imuControl(false) also throws on simulator — wrap so cleanup completes
      Promise.resolve(bridge.imuControl(false)).catch(() => {}),
    ])
  }

  audio.onFrame(frame => {
    rms.push(frame.samples)
    sampleBuffer.push(frame.samples)
    const directionEstimate = direction.feed(frame)
    const spike = spikes.feed(rms.getCurrent(), rms.getBaseline(), frame.frameIndex)
    if (spike) {
      const localizedSpike = {
        ...spike,
        direction: direction.getRecentBest(spike.frameIndex) ?? directionEstimate,
      }
      const classification = classifier.classify(sampleBuffer.getRecent(500))
      console.log(
        `[clearpath] SPIKE frame=${spike.frameIndex} ratio=${spike.ratio.toFixed(2)} peak=${spike.peakRms.toFixed(4)} dur=${spike.durationMs}ms location=${localizedSpike.direction?.label ?? 'unknown'} confidence=${localizedSpike.direction?.confidence.toFixed(2) ?? '0.00'}`,
      )
      console.log(
        `[clearpath] CLASS[heuristic] ${classification.className} (conf=${classification.confidence.toFixed(2)}) ` +
        `centroid=${classification.features?.spectralCentroidHz.toFixed(0)}Hz ` +
        `zcr=${classification.features?.zeroCrossingRate.toFixed(3)}`
      )
      fsm.alert(localizedSpike, classification)
      approach.startWatch(spike.peakRms, frame.frameIndex)

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
    const verdict = approach.feed(rms.getCurrent(), frame.frameIndex)
    if (verdict) {
      console.log(
        `[clearpath] APPROACH verdict approaching=${verdict.approaching} growth=${verdict.growth.toFixed(2)}x (spike=${verdict.spikePeakRms.toFixed(4)} watch=${verdict.watchPeakRms.toFixed(4)})`,
      )
      if (verdict.approaching) fsm.upgradeToApproaching()
    }
    if (frame.frameIndex % 50 === 0) {
      console.log(
        `[clearpath] frame=${frame.frameIndex} rms=${rms.getCurrent().toFixed(4)} baseline=${rms.getBaseline().toFixed(4)} channels=${frame.channelCount} state=${fsm.current().kind}`,
      )
    }
    renderer.render(
      radarSignalFromState(fsm.current(), rms.getCurrent(), rms.getBaseline(), direction.getLatest()),
    )
  })

  fsm.onChange(state => {
    console.log(`[clearpath] state -> ${state.kind}`)
    renderer.render(
      radarSignalFromState(state, rms.getCurrent(), rms.getBaseline(), direction.getLatest()),
      true,
    )
  })

  // Periodic tick for ALERTING auto-clear (4s)
  setInterval(() => fsm.tick(Date.now()), 250)

  // Double-tap to exit; IMU samples are used as head-pose context for sound direction.
  unsubscribeEvents = bridge.onEvenHubEvent(async event => {
    const sys = event.sysEvent
    const sysType = sys?.eventType ?? null
    const textType = event.textEvent?.eventType ?? null

    if (event.audioEvent && !loggedAudioShape) {
      loggedAudioShape = true
      const keys = event.jsonData ? Object.keys(event.jsonData).join(',') : 'none'
      console.log(
        `[clearpath] audio payload bytes=${event.audioEvent.audioPcm.byteLength} rawKeys=${keys}`,
      )
    }

    if (sys?.imuData && sysType === OsEventTypeList.IMU_DATA_REPORT) {
      direction.updateImu(sys.imuData)
      return
    }

    if (
      sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT ||
      sysType === OsEventTypeList.SYSTEM_EXIT_EVENT
    ) {
      await stopSensors()
      return
    }

    if (
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      textType === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      await stopSensors()
      await bridge.shutDownPageContainer(1)
    }
  })

  window.addEventListener('beforeunload', () => {
    void stopSensors()
  })

  // imuControl is a glasses-only API — the simulator throws "unknown variant
  // imuControl" because its bridge stub doesn't implement it. Catch and
  // continue: direction estimator falls back to audio-only if no IMU samples
  // arrive, and the rest of the demo (audio capture, classification, radar
  // arrows from the multi-mic data) keeps working.
  try {
    const imuStarted = await bridge.imuControl(true, ImuReportPace.P500)
    if (!imuStarted) console.warn('[clearpath] IMU capture failed to start')
  } catch (err) {
    console.warn('[clearpath] IMU not supported in this host (likely simulator):', err)
  }
  await renderer.initialize()
  await audio.start()
  console.log('[clearpath] audio capture started')
}

main().catch(err => {
  console.error('[clearpath] fatal:', err)
  setText(detailEl, err instanceof Error ? err.message : String(err))
})
