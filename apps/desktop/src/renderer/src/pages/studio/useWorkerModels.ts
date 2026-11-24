import { useCallback, useEffect, useRef, useState } from 'react'
import { Events, Ipc } from '@shared/channels'
import type { RemoteWorkerModelInventory } from '@shared/remoteWorker'
import { call, onEvent } from '../../lib/api'

export interface WorkerModelsState {
  /** The Worker host's detected models and components; null while unknown or offline. */
  inventory: RemoteWorkerModelInventory | null
  loading: boolean
  error: string | null
  reload: (rescan?: boolean) => void
}

/**
 * Queries the real models currently installed on the selected Worker host
 * (via `/v1/models` on its daemon) and automatically refreshes after remote
 * downloads or host updates. A daemon that does not name `models` in its
 * capabilities answers `{ unsupported: true, models: [], components: [] }`.
 */
export function useWorkerModels(hostId: string | null): WorkerModelsState {
  const [inventory, setInventory] = useState<RemoteWorkerModelInventory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trigger, setTrigger] = useState<{ round: number; rescan: boolean }>({ round: 0, rescan: false })
  const seq = useRef(0)
  const lastHost = useRef<string | null>(null)

  const reload = useCallback((rescan = false) => {
    setTrigger((prev) => ({ round: prev.round + 1, rescan }))
  }, [])

  useEffect(() => {
    const request = ++seq.current
    const hostChanged = lastHost.current !== hostId
    lastHost.current = hostId
    setError(null)
    if (!hostId) {
      setInventory(null)
      setLoading(false)
      return
    }
    if (hostChanged) setInventory(null)
    setLoading(true)
    call<RemoteWorkerModelInventory>(Ipc.remoteWorkerModels, { hostId, rescan: trigger.rescan })
      .then((value) => {
        if (request === seq.current && value && Array.isArray(value.models)) {
          setInventory(value)
        }
      })
      .catch((reason: unknown) => {
        if (request === seq.current) {
          setInventory(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (request === seq.current) setLoading(false)
      })
  }, [hostId, trigger])

  useEffect(() => {
    if (!hostId) return
    const refresh = (): void => setTrigger((prev) => ({ round: prev.round + 1, rescan: false }))
    const stopModels = onEvent(Events.modelsChanged, refresh)
    const stopHosts = onEvent(Events.hostsChanged, refresh)
    return () => {
      stopModels()
      stopHosts()
    }
  }, [hostId])

  return { inventory, loading, error, reload }
}
