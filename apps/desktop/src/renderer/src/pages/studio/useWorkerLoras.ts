import { useCallback, useEffect, useRef, useState } from 'react'
import { Ipc } from '@shared/channels'
import { call } from '../../lib/api'
import { parseWorkerLoras, type WorkerLoraItem } from './remoteWorkerLoras'

export interface WorkerLoras {
  /** The Worker's registered LoRA; null while unknown (no host, still reading, or the read failed). */
  items: WorkerLoraItem[] | null
  loading: boolean
  error: string | null
  reload: () => void
}

/** The LoRA the Worker host picked as 运行位置 has registered. Nothing is read without one. */
export function useWorkerLoras(hostId: string | null): WorkerLoras {
  const [items, setItems] = useState<WorkerLoraItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    const request = ++seq.current
    setItems(null)
    setError(null)
    if (!hostId) {
      setLoading(false)
      return
    }
    setLoading(true)
    call<unknown>(Ipc.remoteWorkerLoras, { hostId })
      .then((value) => {
        if (request === seq.current) setItems(parseWorkerLoras(value))
      })
      .catch((reason: unknown) => {
        if (request === seq.current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (request === seq.current) setLoading(false)
      })
  }, [hostId, round])

  const reload = useCallback(() => setRound((value) => value + 1), [])
  return { items, loading, error, reload }
}
