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
  const spikes = createSpikeDetector({
    ratioThreshold: 1.6,
    minDurationMs: 100,
    cooldownMs: 1000,
  })
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
    await Promise.allSettled([audio.stop(), bridge.imuControl(false)])
  }

  audio.onFrame(frame => {
    rms.push(frame.samples)
    const directionEstimate = direction.feed(frame)
    const spike = spikes.feed(rms.getCurrent(), rms.getBaseline(), frame.frameIndex)
    if (spike) {
      const localizedSpike = {
        ...spike,
        direction: direction.getRecentBest(spike.frameIndex) ?? directionEstimate,
      }
      console.log(
        `[clearpath] SPIKE frame=${spike.frameIndex} ratio=${spike.ratio.toFixed(2)} peak=${spike.peakRms.toFixed(4)} dur=${spike.durationMs}ms location=${localizedSpike.direction?.label ?? 'unknown'} confidence=${localizedSpike.direction?.confidence.toFixed(2) ?? '0.00'}`,
      )
      fsm.alert(localizedSpike)
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

  const imuStarted = await bridge.imuControl(true, ImuReportPace.P500)
  if (!imuStarted) console.warn('[clearpath] IMU capture failed to start')
  await renderer.initialize()
  await audio.start()
  console.log('[clearpath] audio capture started')
}

main().catch(err => {
  console.error('[clearpath] fatal:', err)
  setText(detailEl, err instanceof Error ? err.message : String(err))
})
