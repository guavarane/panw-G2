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
import { createClassifier } from './audio/classifier'
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
  const spikes = createSpikeDetector({
    ratioThreshold: 2.5,
    minDurationMs: 150,
    cooldownMs: 1000,
  })
  const approach = createApproachDetector()
  const sampleBuffer = createSampleBuffer(1200)   // keep last 1.2 s for heuristic + LLM classification
  const classifier = createClassifier()
  const llmClassifier = createLlmClassifier(import.meta.env.VITE_GEMINI_API_KEY)
  console.log(`[clearpath] LLM classifier ${llmClassifier.isAvailable() ? 'enabled' : 'disabled (no VITE_GEMINI_API_KEY)'}`)
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
      // Captures a wider 1 s window for richer context.
      if (llmClassifier.isAvailable()) {
        const audioForLlm = sampleBuffer.getRecent(1000)
        llmClassifier.classify(audioForLlm).then(llmResult => {
          if (!llmResult) return
          // Only upgrade if we're still alerting on the same spike (state may have cleared).
          const currentState = fsm.current()
          if (currentState.kind !== 'ALERTING' || currentState.spike.frameIndex !== spike.frameIndex) {
            console.log('[clearpath] LLM result arrived but alert already cleared — discarding')
            return
          }
          console.log(
            `[clearpath] CLASS[llm] ${llmResult.className} "${llmResult.description}" ` +
            `conf=${llmResult.confidence.toFixed(2)} urgency=${llmResult.urgency}`
          )
          fsm.attachClassification({
            className: llmResult.className,
            confidence: llmResult.confidence,
            source: 'llm',
            description: llmResult.description,
            urgency: llmResult.urgency,
          })
        }).catch(err => console.warn('[clearpath] LLM classify failed:', err))
      }
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
