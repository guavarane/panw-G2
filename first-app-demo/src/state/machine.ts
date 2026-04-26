import type { SpikeEvent } from '../audio/spike-detector'

export type AppState =
  | { kind: 'IDLE' }
  | { kind: 'ALERTING'; spike: SpikeEvent; startedAt: number }

export interface StateMachine {
  current(): AppState
  alert(spike: SpikeEvent): void
  tick(now: number): void
  onChange(handler: (state: AppState) => void): () => void
}

const ALERT_DURATION_MS = 4000

export function createStateMachine(): StateMachine {
  let state: AppState = { kind: 'IDLE' }
  const handlers = new Set<(state: AppState) => void>()

  function setState(next: AppState) {
    state = next
    for (const handler of handlers) handler(state)
  }

  return {
    current: () => state,
    alert(spike) {
      setState({ kind: 'ALERTING', spike, startedAt: Date.now() })
    },
    tick(now) {
      if (state.kind === 'ALERTING' && now - state.startedAt >= ALERT_DURATION_MS) {
        setState({ kind: 'IDLE' })
      }
    },
    onChange(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}
