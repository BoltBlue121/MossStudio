---
status: record
date: 2026-11-20
code: apps/desktop/src/shared/capabilities/, apps/desktop/src/main/capabilities/, apps/desktop/src/renderer/src/lib/capabilities/, apps/desktop/src/renderer/src/pages/studio/studioCapabilities.ts
---

# Capability tool-layer consolidation record (2026-11-20)

Dated record of the unified MossStudio capability tool layer built on branch `refactor/capability-protocol` against `ShallowElec/MossStudio` `main` @ `6707fc7be0b9f3a9f65c6d726aac87523b908eb8`. Records the complete pack inventory, audit trail design and verification evidence.

## Pack inventory (14 packs, 98 actions)

| Pack | Target | Gate | Actions | Scope |
| --- | --- | --- | ---: | --- |
| `studio.board.read` | renderer | none | 4 | Read context/canvas, select canvas, full `deriveReadiness` diagnostics |
| `studio.ask` | renderer | none | 2 | Choice and confirm interactive cards |
| `studio.board.cards` | renderer | none | 9 | Prompt, scenes, create/duplicate/style/upscale/scale/delete/tidy cards |
| `studio.board.regions` | renderer | none | 7 | Add/edit/remove regions by index or stable `layerId`, reorder layers |
| `studio.board.sampling` | renderer | none | 4 | Basic sampler, model bundle switch, LoRAs, advanced sampling & hires |
| `studio.board.wires` | renderer | none | 6 | Connect/disconnect typed slots, tune init/control/references, board recipes |
| `studio.board.runs` | renderer | none | 6 | Generate, cancel, pin/unpin filmstrip runs, apply run settings, drop run |
| `studio.projects` | main + renderer | none | 8 | List/get/open/create/rename/save/delete projects, import image card |
| `studio.gbc.parse` | main | `gbcEnabled` | 5 | KohakuGBC status, single parse, batch/GBC-Nest job start/snapshot/cancel |
| `library.assets` | main | none | 4 | List/search Library, read metadata, read image base64 for vision review, trash |
| `models.catalog` | main | none | 10 | Catalog, installed inventory, control adapters, downloads, disk space, install/delete |
| `manga.series` | main | none | 4 | List, read, save and delete 漫画 series |
| `training.jobs` | main | `trainingEnabled` | 15 | Readiness, projects CRUD, dataset/captions, samples, command, start/stop/choose step |
| `system.runtime` | main | none | 14 | Engine status/features, GPU inventory, jobs/logs/cancel, diagnostics, global context, window focus, visual reviews, audit trail, official promptcraft and layout skills |

## Audit trail (操作留痕)

- Every invocation through `MainCapabilityDispatcher` (including built-in `ai:chat` tool calls and `capabilities:execute` IPC calls) appends one JSON line to `<dataRoot>/logs/capabilities.jsonl` without secrets and mirrors recent entries in memory (`listCapabilityAudit` / `system.audit.recent`).
- Visual-review records from agent iterations persist atomically to `<dataRoot>/logs/reviews/<jobId>.json` via `system.reviews.record` and `system.reviews.get`.

## Boundary kept clean

- Zero non-MossInfer inference backends or vendor-specific external agent adapters entered this branch.
- Completeness unit tests assert that every `target: 'main'` action has a live handler in `createBuiltinMainHandlers()` and every `target: 'renderer'` action is mounted by `registerStudioCapabilities()`.
