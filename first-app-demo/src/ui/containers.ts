import { CreateStartUpPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk'

export const MAIN_CONTAINER_ID = 1
export const MAIN_CONTAINER_NAME = 'main'

export function buildStartupPage(initialContent: string): CreateStartUpPageContainer {
  const mainText = new TextContainerProperty({
    xPosition: 8,
    yPosition: 8,
    width: 560,
    height: 272,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MAIN_CONTAINER_ID,
    containerName: MAIN_CONTAINER_NAME,
    content: initialContent,
    isEventCapture: 1,
  })
  return new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [mainText] })
}
