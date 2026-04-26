import './styles.css'
import {
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

const bridgeStatus = document.querySelector<HTMLDListElement>('#bridge-status')
const pageStatus = document.querySelector<HTMLDListElement>('#page-status')
const detail = document.querySelector<HTMLParagraphElement>('#detail')

const GLASSES_TEXT = 'Hello from G2!'

function setText(node: Element | null, text: string) {
  if (node) {
    node.textContent = text
  }
}

function describeResult(result: StartUpPageCreateResult) {
  switch (result) {
    case StartUpPageCreateResult.success:
      return 'Success'
    case StartUpPageCreateResult.invalid:
      return 'Invalid container'
    case StartUpPageCreateResult.oversize:
      return 'Container too large'
    case StartUpPageCreateResult.outOfMemory:
      return 'Out of memory'
    default:
      return `Unknown result ${result}`
  }
}

async function createStartupPage() {
  setText(bridgeStatus, 'Waiting')
  setText(pageStatus, 'Not sent')
  setText(detail, 'Preparing the Even App bridge.')

  try {
    const bridge = await waitForEvenAppBridge()
    setText(bridgeStatus, 'Ready')
    setText(detail, 'Sending the startup page to the G2 display.')

    const mainText = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: 1,
      containerName: 'main',
      content: GLASSES_TEXT,
      isEventCapture: 1,
    })

    const result = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [mainText],
      }),
    )

    const resultText = describeResult(result)
    setText(pageStatus, resultText)
    setText(
      detail,
      result === StartUpPageCreateResult.success
        ? 'The startup page is live on the simulated or connected glasses.'
        : `The bridge replied with: ${resultText}. Run through the simulator or hardware WebView for a real bridge response.`,
    )
    console.log('[first-app-demo] startup page result:', result, resultText)
  } catch (error) {
    setText(bridgeStatus, 'Unavailable')
    setText(pageStatus, 'Skipped')
    setText(
      detail,
      error instanceof Error ? error.message : 'The Even App bridge was not available.',
    )
    console.error('[first-app-demo] failed to create startup page:', error)
  }
}

createStartupPage()

