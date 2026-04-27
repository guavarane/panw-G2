import { CreateStartUpPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk'

export const LEFT_RADAR_CONTAINER_ID = 1
export const LEFT_RADAR_CONTAINER_NAME = 'leftRadar'
export const RIGHT_RADAR_CONTAINER_ID = 2
export const RIGHT_RADAR_CONTAINER_NAME = 'rightRadar'

export function buildStartupPage(): CreateStartUpPageContainer {
  const leftRadar = new TextContainerProperty({
    xPosition: 8,
    yPosition: 30,
    width: 260,
    height: 230,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 4,
    containerID: LEFT_RADAR_CONTAINER_ID,
    containerName: LEFT_RADAR_CONTAINER_NAME,
    content: ' ',
    isEventCapture: 1,
  })

  const rightRadar = new TextContainerProperty({
    xPosition: 308,
    yPosition: 30,
    width: 260,
    height: 230,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 4,
    containerID: RIGHT_RADAR_CONTAINER_ID,
    containerName: RIGHT_RADAR_CONTAINER_NAME,
    content: ' ',
    isEventCapture: 0,
  })

  return new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [leftRadar, rightRadar],
  })
}
