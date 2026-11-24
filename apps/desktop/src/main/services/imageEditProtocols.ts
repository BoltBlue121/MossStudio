import { z } from 'zod'
import type { ImageEditChannel } from '@shared/schemas'
import { IMAGE_BYTES, imageEditHttp } from '../lib/imageEditHttp'
import { readImageHeader, type ImageHeader } from './imageHeaders'

const PIXELS = 25_000_000
const names = z.object({ models: z.array(z.object({ name: z.string() })) }),
  ids = z.object({ data: z.array(z.object({ id: z.string() })) })
const inlineData = z.object({ mimeType: z.string(), data: z.string() }).optional()
const content = z.object({ parts: z.array(z.object({ inlineData })) })
const geminiReply = z.object({ candidates: z.array(z.object({ content })) })
const image_url = z.object({ url: z.string() }),
  message = z.object({ images: z.array(z.object({ image_url })) })
const chatReply = z.object({ choices: z.array(z.object({ message })) })
function header(bytes: Buffer) {
  const h = readImageHeader(bytes)
  if (!h || !h.width || !h.height || Math.max(h.width, h.height) > 8192 || h.width * h.height > PIXELS || bytes.length > IMAGE_BYTES)
    throw new Error('请选择大小和尺寸合适的 PNG、JPEG 或 WebP 图片')
  return h
}
// Decoders accept a picture cut off after its last scanline, so a truncated reply would import as a damaged picture.
function complete(bytes: Buffer, h: ImageHeader) {
  if (h.format === 'png' && bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082') throw new Error('PNG 不完整')
  if (h.format === 'jpeg' && bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new Error('JPEG 不完整')
  if (h.format === 'webp' && bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('WebP 不完整')
  return bytes
}
type Endpoint = Pick<ImageEditChannel, 'protocol' | 'baseUrl' | 'model'>
type Redraw = { bytes: Buffer; prompt: string; signal?: AbortSignal }
export async function queryChannel(c: Endpoint, key: string, guard: () => void, input?: Redraw) {
  const gemini = c.protocol === 'gemini-native'
  const headers: Record<string, string> = gemini ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }
  const base = c.baseUrl.replace(/\/+$/, '') + '/'
  const send = (endpoint: string, body: FormData | string | null) => imageEditHttp(base + endpoint, headers, body, guard, input?.signal)
  if (!input) {
    const raw = await send('models', null)
    const models = gemini ? names.parse(raw).models.map((m) => m.name.replace(/^models\//, '')) : ids.parse(raw).data.map((m) => m.id)
    const score = (s: string) => Number(/image|imagen|dall-e|flux/i.test(s))
    return [...new Set(models.filter((id) => id.length <= 256 && !id.includes(key)))].sort((a, b) => score(b) - score(a))
  }
  const { bytes, prompt } = input,
    mime = `image/${header(bytes).format}`
  let b64: string | undefined, declared: string | undefined
  if (c.protocol === 'openai-edits') {
    const form = new FormData()
    form.set('model', c.model)
    form.set('prompt', prompt)
    form.set('image', new Blob([new Uint8Array(bytes)], { type: mime }), `picture.${mime.slice(6)}`)
    if (!/(?:^|\/)gpt-image/i.test(c.model)) form.set('response_format', 'b64_json')
    const raw = await send('images/edits', form)
    b64 = z.object({ data: z.array(z.object({ b64_json: z.string() })) }).parse(raw).data[0]?.b64_json
  } else {
    headers['Content-Type'] = 'application/json'
    const data = bytes.toString('base64')
    if (gemini) {
      const contents = [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data } }] }]
      const body = { contents, generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }
      const raw = await send(`models/${encodeURIComponent(c.model)}:generateContent`, JSON.stringify(body))
      const part = geminiReply.parse(raw).candidates[0]?.content.parts.find((p) => p.inlineData)?.inlineData
      b64 = part?.data
      declared = part?.mimeType
    } else {
      const content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } },
      ]
      const body = { model: c.model, modalities: ['image', 'text'], messages: [{ role: 'user', content }] }
      const raw = await send('chat/completions', JSON.stringify(body))
      const url = chatReply.parse(raw).choices[0]?.message.images[0]?.image_url.url
      const prefix = url?.match(/^data:(image\/(?:png|jpeg|webp));base64,/)
      declared = prefix?.[1]
      b64 = prefix ? url!.slice(prefix[0].length) : undefined
    }
  }
  if (!b64 || b64.length > 4 * Math.ceil(IMAGE_BYTES / 3)) throw new Error('渠道未返回可用图片')
  const out = Buffer.from(b64, 'base64')
  const h = header(out)
  if (out.toString('base64') !== b64 || (declared !== undefined && declared !== `image/${h.format}`)) throw new Error('图片编码或类型无效')
  input.signal?.throwIfAborted()
  return complete(out, h)
}
