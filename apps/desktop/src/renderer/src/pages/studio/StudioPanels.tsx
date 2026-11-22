import type { ReactNode } from 'react'

export type PanelId = 'assistant' | 'gbc'

/** Hiding chat preserves an in-flight turn; the parser only needs resources while open. */
export function StudioPanels({
  active,
  assistant,
  gbc,
}: {
  active: PanelId | null
  assistant: ReactNode
  gbc: ReactNode
}): React.JSX.Element {
  return (
    <>
      <div hidden={active !== 'assistant'} className="contents">
        {assistant}
      </div>
      {active === 'gbc' ? gbc : null}
    </>
  )
}
