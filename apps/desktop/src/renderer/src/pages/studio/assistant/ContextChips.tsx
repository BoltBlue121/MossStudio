import { Check, Plus } from 'lucide-react'
import { cn } from '../../../components/ui'
import type { ContextChip, ContextFilter, ContextPart } from './collabContext'

/**
 * What goes along with the next message, one chip per part of the board.
 * A chip that is off leaves its part out of `studioContext`.
 */
export function ContextChips({
  chips,
  filter,
  onToggle,
}: {
  chips: readonly ContextChip[]
  filter: ContextFilter
  onToggle: (part: ContextPart) => void
}): React.JSX.Element | null {
  if (!chips.length) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="随消息附带的画板信息" data-context-chips>
      <span className="shrink-0 text-micro text-ink-2">附带</span>
      {chips.map((chip) => {
        const on = filter[chip.part] !== false
        return (
          <button
            key={chip.part}
            type="button"
            aria-pressed={on}
            data-context-chip={chip.part}
            title={`${on ? '会附带' : '不附带'}：${chip.detail}`}
            onClick={() => onToggle(chip.part)}
            className={cn(
              'inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-caption transition-colors',
              on ? 'bg-accent-soft text-ink hover:bg-accent-soft' : 'bg-well text-ink-2 hover:bg-well-strong',
            )}
          >
            {on ? (
              <Check className="size-3 shrink-0" aria-hidden="true" strokeWidth={1.6} />
            ) : (
              <Plus className="size-3 shrink-0" aria-hidden="true" strokeWidth={1.6} />
            )}
            <span className="min-w-0 truncate">{chip.label}</span>
          </button>
        )
      })}
    </div>
  )
}
