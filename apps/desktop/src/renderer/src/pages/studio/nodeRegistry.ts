import { Frame, Image, Palette } from 'lucide-react'

/** Only nodes the picker can create directly; results need a run and upscaling needs a source. */
export const nodeRegistry = [
  { nodeId: 'layout', label: '新建画面', icon: Frame, description: '用描述和区域生成图片' },
  { nodeId: 'style', label: '新建风格', icon: Palette, description: '让多个画面共用描述和 LoRA' },
  { nodeId: 'image', label: '导入图片…', icon: Image, description: '从文件导入图片，作为画面的输入' },
] as const

export type CreatableNodeId = (typeof nodeRegistry)[number]['nodeId']
