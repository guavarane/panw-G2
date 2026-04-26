import './styles.css'
import {
  OsEventTypeList,
  StartUpPageCreateResult,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { createAudioStream } from './audio/stream'
import { createRmsTracker } from './audio/rms'
import { createSpikeDetector } from './audio/spike-detector'
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
  const fsm = createStateMachine()
  const renderer = new Renderer(bridge, 200)
  const audio = createAudioStream(bridge)

  audio.onFrame((samples, frameIndex) => {
    rms.push(samples)
    const spike = spikes.feed(rms.getCurrent(), rms.getBaseline(), frameIndex)
    if (spike) {
      console.log(
        `[clearpath] SPIKE frame=${spike.frameIndex} ratio=${spike.ratio.toFixed(2)} peak=${spike.peakRms.toFixed(4)} dur=${spike.durationMs}ms`,
      )
      fsm.alert(spike)
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
