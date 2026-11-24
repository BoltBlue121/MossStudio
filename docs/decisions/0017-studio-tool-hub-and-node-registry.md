---
status: proposed
date: 2026-11-22
last-verified: 2026-11-22 (working tree based on 7c24fee)
code: apps/desktop/src/renderer/src/pages/studio/, apps/desktop/src/renderer/src/lib/features.ts
---

# ADR-0017: Register Studio nodes and workbench actions in source

Offer one optional picker for board actions. Register their descriptions in the renderer,
without changing saved projects, starting services or granting new Agent permissions.

## Context and problem statement

The board already supports several ways to start a picture, and its menus know where a person clicked. Adding a top-level button for each workflow would crowd the canvas. GBC also needs both a parser panel and a command that acts on a particular picture; these are not the same operation.

## Decision drivers

- Preserve the existing toolbar, context-menu order and click position, starter row, shortcuts and undo steps.
- Describe new tools once, while letting selection, engine support and feature settings determine what works now.
- Keep UI variants distinct from the stored canvas kind, and local actions distinct from authority to call external tools.

## Considered options

1. Add bespoke buttons and handlers per feature. This is small for one action but duplicates availability and history rules across entry points.
2. Compose typed descriptors in source and expose them through a single optional picker.
3. Discover plugins at runtime or generate the picker from MCP capabilities. The former needs a trust and lifecycle model; the latter conflates a person's board gestures with external authorization. Neither is needed for in-tree tools.

## Decision outcome

Choose option 2. The [node registry](../../apps/desktop/src/renderer/src/pages/studio/nodeRegistry.ts) lists only the nodes the picker can create directly. Its IDs determine which creation commands the board must handle; the remaining fields supply the menu label, icon and description. Upscaling starts from a picture or recipe, and only a run produces a result. The picker does not define ports or persisted kinds.

[Built-in actions](../../apps/desktop/src/renderer/src/pages/studio/builtinBoardTools.ts) contribute a slot, group, order and command. The picker delegates to the same project callbacks as the context menu and starter row. It does not synthesize a right-click or open another undo transaction. `toolHubEnabled` is off by default and changes only discovery; it never enables GBC.

**Visibility, executability and authorization are separate.** Hidden actions are omitted; disabled ones explain what is missing. Dispatch checks availability again before running a command. A picker entry registers no tool with the assistant or MCP and grants no permission. See [ADR-0016](0016-external-agents-over-mcp.md).

**One owner of the right sidebar.** Studio holds one transient panel ID or `null`. Assistant is hidden, not removed, so switching to GBC or closing the sidebar does not discard an in-flight turn. GBC mounts only while selected and enabled; switching it off also clears its selection. Opening it from the hub or title bar selects the same panel. The picker itself is transient and owns no project or chat state.

### Consequences

New in-tree tools are discoverable in a stable place and reviewed with their commands. Built-in menus retain their context-specific behavior; a new tool must opt into any additional surface explicitly. Shipping a new contribution requires a build, and neither third-party code loading nor a 3D renderer or external editing provider is part of this decision.

### Not built

For a 3D placement or API editing workflow, first decide whether existing project data can represent its output. Add a picker entry only when a board operation implements it. A new persisted shape needs its own migration and review.

### Confirmation

Registry tests exercise identity, visibility, dispatch rejection, focus dismissal and panel lifetime. The dedicated ToolHub E2E covers the absent default trigger, grouped picker, recipe undo and assistant draft; the existing board, Studio, GBC and external Agent specs remain the compatibility checks.
