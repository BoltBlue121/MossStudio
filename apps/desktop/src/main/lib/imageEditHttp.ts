import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { TLSSocket } from 'node:tls'

const denied = new BlockList()
for (const cidr of '0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4 168.63.129.16/32'.split(
  ' ',
)) {
  const [ip, prefix] = cidr.split('/')
  denied.addSubnet(ip!, Number(prefix), 'ipv4')
}
for (const [ip, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  denied.addSubnet(ip, prefix, 'ipv6')
export function publicAddress(ip: string): boolean {
  return isIP(ip) === 4 ? !denied.check(ip, 'ipv4') : isIP(ip) === 6 && /^[23]/.test(ip) && !denied.check(ip, 'ipv6')
}
export function publicImageUrl(value: string): URL {
  const url = URL.canParse(value) ? new URL(value) : null
  const host = url?.hostname.replace(/^\[|\]$/g, '') ?? ''
  if (
    !url ||
    url.protocol !== 'https:' ||
    !/^https:\/\/[^/@]+(?:\/|$)/i.test(value) ||
    /[?#\\\s]/.test(value) ||
    url.username ||
    url.password ||
    (isIP(host) ? !publicAddress(host) : !host.includes('.') || /(?:^|\.)(localhost|local)\.?$/i.test(host))
  )
    throw new Error('仅支持不带凭据或参数的公网 HTTPS 地址')
  return url
}
async function readResponse(res: import('node:http').IncomingMessage, limit: number) {
  if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) throw new Error()
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > limit) throw new Error()
    parts.push(chunk)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
}
export const IMAGE_BYTES = 16 * 1024 * 1024
/** Never follow redirects or reuse sockets. The lookup result feeds the actual socket, not a preliminary probe. */
export async function imageEditHttp(
  url: string,
  headers: Record<string, string>,
  body: FormData | string | null,
  guard: () => void,
  caller?: AbortSignal,
): Promise<unknown> {
  const address = publicImageUrl(url)
  const method = body ? 'POST' : 'GET'
  const deadline = AbortSignal.timeout(body ? 120000 : 10000)
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline
  const limit = body ? Math.ceil(IMAGE_BYTES / 3) * 4 + 128 * 1024 : 512 * 1024
  try {
    const payload = new Request(address, { method, headers, body })
    const data = body ? Buffer.from(await payload.arrayBuffer()) : undefined
    signal.throwIfAborted()
    guard()
    return await new Promise((resolve, reject) => {
      const req = request(
        address,
        {
          method,
          headers: Object.fromEntries(payload.headers),
          signal,
          agent: false,
          lookup: (host, opts, done) => {
            void lookup(host, { all: true })
              .then((rows) => {
                if (!rows.length || rows.some((row) => !publicAddress(row.address))) throw new Error()
                if (opts.all) done(null, rows)
                else done(null, rows[0]!.address, rows[0]!.family)
              })
              .catch(() => done(new Error('地址不可用'), '', 0))
          },
        },
        (res) => {
          void readResponse(res, limit).then(resolve, () => {
            res.destroy()
            reject(new Error())
          })
        },
      )
      req.on('error', reject)
      req.on('socket', (socket) =>
        (socket as TLSSocket).once('secureConnect', () => {
          try {
            signal.throwIfAborted()
            guard()
            req.end(data)
          } catch {
            req.destroy(new Error())
          }
        }),
      )
    })
  } catch {
    throw new Error('渠道请求失败：请检查地址、密钥、模型和返回格式')
  }
}
