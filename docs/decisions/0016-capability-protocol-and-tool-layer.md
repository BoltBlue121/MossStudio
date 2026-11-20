---
status: proposed
date: 2026-11-20
code: apps/desktop/src/shared/capabilities/, apps/desktop/src/shared/agent/registry.ts, apps/desktop/src/renderer/src/lib/capabilities/, apps/desktop/src/renderer/src/lib/agent/executor.ts, apps/desktop/src/renderer/src/pages/studio/studioCapabilities.ts
---

# ADR-0016: Transport-independent capability protocol and unified tool layer

## Context and problem statement

The Studio assistant ([studio-assistant.md](../reference/studio-assistant.md)) introduced a clean tool rack (`shared/agent/schemas.ts`, `shared/agent/registry.ts`, `renderer/src/lib/agent/executor.ts`) covering 13 `studio_*` tools wired into `StudioPage.tsx` through a single global `StudioToolApi`.

As MossStudio grows across cards, styles, upscales, wires, LoRA/sampling, filmstrip runs, KohakuGBC, 漫画, 作品, 模型 and 训练 — and prepares to serve future transports such as MCP connectors or optional external agent front ends — the single-table tool rack hits four structural limits:

1. **Narrow coverage and implicit focus.** Most Studio pure-function operations (`canvases.ts`, `nodes.ts`, `links.ts`, `runs.ts`, `sampling.ts`, `readiness.ts`) are unavailable to tools, and existing mutations act only on the currently selected canvas rather than explicit `canvasId` / `layerId` targets.
2. **Tight coupling to the built-in chat loop.** `main/ipc.ts` hard-codes `resolveToolset({ page: 'studio' })`, `StudioPage.tsx` mounts one monolithic `StudioToolApi`, and `Events.aiStream` / `Events.aiToolCall` lacked `conversationId` isolation.
3. **No declarative extension protocol.** Adding a new module's tools or attaching an external tool source requires editing central switch/handler tables instead of registering a self-describing pack or verified manifest.
4. **Static prompt guidance.** `TOOL_RULES` is a fixed constant that cannot adapt when optional feature flags, surfaces or tool subsets change.

## Decision drivers

- Preserve 100% backward compatibility with the built-in Studio assistant, its 13 `studio_*` tools, its `auto` / `advanced` modes, and all existing unit and E2E tests.
- Keep `src/shared/` free of Electron, Node, DOM and transport SDK imports (zero coupling to MCP or any specific external agent protocol).
- Reuse the pure Studio domain functions instead of duplicating canvas/wire/run logic in the main process.
- Allow future built-in modules (`gbc`, `manga`, `library`, `models`, `training`) and external connectors to register capabilities declaratively with explicit effect and policy metadata.
- Keep this refactor UI-free and self-contained (non-stacked PR).

## Considered options

1. **Keep extending `TOOL_SCHEMAS` and `StudioToolApi` inline** — fastest for one or two tools, but scales poorly across pages/packs, leaves `StudioPage.tsx` monolithic, and forces external transports to invent parallel RPC layers.
2. **Adopt a transport-independent Capability Contribution Protocol (`shared/capabilities/`) and pack-scoped `RendererCapabilityHost`** — one registry owns descriptors, closed JSON Schemas, effect/policy floors, external manifest digest verification and dynamic Markdown skill synthesis; `shared/agent/` projects the legacy 13-tool view from the same registry.
3. **Build the tool layer directly on top of an MCP server SDK** — couples internal Studio architecture to one wire protocol and adds runtime dependencies before transport needs are settled.

## Decision outcome

Chosen option: **2**.

1. **Capability protocol and registry (`apps/desktop/src/shared/capabilities/`).**
   - `protocol.ts` defines transport-safe descriptors (`CapabilityPack`, `ActionDescriptor`, `ContextProviderDescriptor`, `SkillFragment`, `ExternalToolManifest`) with closed JSON Schemas (`additionalProperties: false`), `effects`, `policyFloor`, `target`, `scope`, `surface`, `headless`, `binding`, and deterministic SHA-256 schema digests (`schemaDigest`, pure TypeScript with no `node:crypto` dependency).
   - `registry.ts` provides `createCapabilityRegistry` supporting built-in packs, dynamic unregistering, verified `ExternalToolManifest` registration (rejecting digest mismatches and id/alias collisions), filtering by surface/feature flags/pack dependencies/effects/policy gates, input validation and deterministic `synthesizeSkill()`.
   - `studioPacks.ts` defines seven built-in Studio packs (`studio.board.read`, `studio.ask`, `studio.board.cards`, `studio.board.regions`, `studio.board.sampling`, `studio.board.wires`, `studio.board.runs`) covering the 13 legacy `studio_*` aliases plus 25 pure-function Studio actions (cards, stable `layerId` region edits/reorder, wires/recipes, model/LoRA/hires sampling, filmstrip runs and full `deriveReadiness` diagnostics).
2. **Backward-compatible legacy bridge (`apps/desktop/src/shared/agent/registry.ts`).**
   - `AGENT_TOOLS`, `toolSchema` and `resolveToolset` derive directly from `BUILTIN_CAPABILITY_REGISTRY` in `LEGACY_TOOL_ORDER`, keeping one source of truth without changing existing assistant contracts.
3. **Pack-scoped renderer host (`apps/desktop/src/renderer/src/lib/capabilities/host.ts` and `pages/studio/studioCapabilities.ts`).**
   - `RendererCapabilityHost` mounts handlers per pack, supports both canonical dotted ids and legacy aliases, enforces `requires` (including `editable-or-style`, fixing the bug where `studio_set_prompt` on a `风格` card was rejected by `precheck`), defers mutating actions into `PlanStep`s under `advanced` mode, and runs `applyPlan`.
   - `StudioPage.tsx` delegates tool binding to `registerStudioCapabilities`, removing ~200 lines of inline tool glue and exposing stable `layer.id` in read snapshots.
4. **Conversation stream isolation.**
   - `AiToolCallRequest` carries `conversationId`, `main/services/ai.ts` passes `conversation.id` to `runTool`, and `Assistant.tsx` filters `Events.aiStream` through `acceptStreamEvent` so concurrent or background sessions never bleed into another open chat.

### Consequences

- **Positive:** Future built-in pages (`manga`, `library`, `models`, `training`, `gbc`) and future transport adapters (such as an MCP connector or an external agent host) consume one typed registry and host without duplicating Studio logic.
- **Positive:** Adding a new pack or verified external manifest requires zero edits to the core registry or executor.
- **Negative / follow-up:** Project-level optimistic concurrency (`ProjectDocument.revision` CAS), main-side action dispatch when `/studio` is unmounted, and per-turn agent undo remain out of scope for this PR and are planned as a separate non-stacked follow-up after this base merges.
