import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BUILTIN_CAPABILITY_REGISTRY,
  CAPABILITY_PROTOCOL_VERSION,
  STUDIO_ACTION_SCHEMAS,
  STUDIO_CAPABILITY_PACKS,
  createCapabilityRegistry,
  createStudioCapabilityRegistry,
  schemaDigest,
  sha256Text,
  type BuiltinCapabilityPack,
  type ExternalToolManifest,
} from '@shared/capabilities'
import { AGENT_TOOL_NAMES } from '@shared/agent/registry'

interface JsonSchemaNode {
  type?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
}

function walkSchema(node: JsonSchemaNode, visit: (current: JsonSchemaNode, path: string) => void, path = '$'): void {
  visit(node, path)
  for (const [key, child] of Object.entries(node.properties ?? {})) walkSchema(child, visit, `${path}.${key}`)
}

describe('shared/capabilities protocol and registry', () => {
  it('computes standard SHA-256 digests deterministically in pure TypeScript', () => {
    expect(sha256Text('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Text('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    // Key order does not change schema digests.
    expect(schemaDigest({ type: 'object', additionalProperties: false })).toBe(
      schemaDigest({ additionalProperties: false, type: 'object' }),
    )
  })

  it('registers every Studio pack with closed JSON Schemas and zero duplicate ids or aliases', () => {
    const actions = BUILTIN_CAPABILITY_REGISTRY.listActions()
    expect(STUDIO_CAPABILITY_PACKS.length).toBe(7)
    expect(actions.length).toBe(Object.keys(STUDIO_ACTION_SCHEMAS).length)

    for (const action of actions) {
      expect(action.input.$schema, action.id).toBeUndefined()
      const root = action.input as JsonSchemaNode
      expect(root.type, action.id).toBe('object')
      walkSchema(root, (node, path) => {
        if (node.type !== 'object') return
        expect(node.additionalProperties, `${action.id} ${path}`).toBe(false)
        for (const key of node.required ?? []) {
          expect(Object.keys(node.properties ?? {}), `${action.id} ${path}`).toContain(key)
        }
      })
    }

    for (const legacyName of AGENT_TOOL_NAMES) {
      const resolved = BUILTIN_CAPABILITY_REGISTRY.getAction(legacyName)
      expect(resolved, legacyName).toBeDefined()
      expect(BUILTIN_CAPABILITY_REGISTRY.getAction(resolved!.descriptor.id)?.descriptor.legacyAlias).toBe(legacyName)
    }
  })

  it('filters actions by surface, feature flags, pack dependencies, effects and policy gate', () => {
    const registry = createStudioCapabilityRegistry()
    const gbcPack: BuiltinCapabilityPack = {
      protocolVersion: CAPABILITY_PROTOCOL_VERSION,
      id: 'studio.gbc.parse',
      title: '看图拆区域',
      version: '1.0.0',
      featureFlag: 'gbcEnabled',
      requiresPacks: ['studio.board.read'],
      actions: [
        {
          id: 'studio.gbc.parse_image',
          title: '看图拆区域',
          description: 'Parse a picture into regions using KohakuGBC.',
          inputSchema: z.strictObject({ path: z.string().min(1) }),
          target: 'main',
          scope: 'project',
          surface: '/studio',
          effects: ['run'],
          policyFloor: 'approval',
          requires: [],
          headless: 'supported',
          summarize: () => '解析参考图',
        },
      ],
      contexts: [],
      skills: [
        {
          id: 'studio.skill.gbc',
          requiresActions: ['studio.gbc.parse_image'],
          order: 70,
          audience: ['tools', 'resources'],
          markdown: '## GBC Parsing\n- Use `studio.gbc.parse_image` to decompose a reference image.',
        },
      ],
    }
    registry.registerBuiltinPack(gbcPack)

    // Flag off: pack and skill stay hidden.
    expect(registry.listActions({ surface: '/studio' }).some((item) => item.id === 'studio.gbc.parse_image')).toBe(false)
    expect(registry.synthesizeSkill({ surface: '/studio' }).fragmentIds).not.toContain('studio.skill.gbc')

    // Flag on: pack and skill appear automatically without editing core files.
    const withGbc = registry.listActions({ surface: '/studio', enabledFlags: { gbcEnabled: true } })
    expect(withGbc.some((item) => item.id === 'studio.gbc.parse_image')).toBe(true)
    const skill = registry.synthesizeSkill({ surface: '/studio', enabledFlags: { gbcEnabled: true } })
    expect(skill.fragmentIds).toContain('studio.skill.gbc')
    expect(skill.markdown).toContain('studio.gbc.parse_image')

    // Pack dependency enforcement: disabling studio.board.read drops dependent packs.
    const onlyCards = registry.listActions({ enabledPacks: ['studio.board.cards'] })
    expect(onlyCards).toEqual([])

    // Policy & effect filtering (proposal-only / read-only projection).
    const readOnly = registry.listActions({
      surface: '/studio',
      excludeEffects: ['write', 'run', 'delete'],
      maxPolicyGate: 'auto',
    })
    expect(readOnly.every((item) => !item.effects.some((e) => ['write', 'run', 'delete'].includes(e)))).toBe(true)
    expect(readOnly.some((item) => item.id === 'studio.board.diagnose')).toBe(true)
    expect(readOnly.some((item) => item.id === 'studio.cards.delete')).toBe(false)
  })

  it('registers external tools from a verified manifest and rejects tampered schema digests or collisions', () => {
    const registry = createStudioCapabilityRegistry()
    const inputSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1 } },
    }
    const manifest: ExternalToolManifest = {
      protocolVersion: 1,
      sourceId: 'ext.catalog.lookup',
      title: '外部素材检索',
      connectorRef: 'connector.mcp.assets',
      mode: 'declared',
      allow: [
        {
          remoteName: 'search_assets',
          localId: 'ext.catalog.search',
          title: '检索素材',
          description: 'Search external reference assets by keyword.',
          input: inputSchema,
          inputDigest: schemaDigest(inputSchema),
          effects: ['read'],
          policyFloor: 'auto',
        },
      ],
    }

    const pack = registry.registerExternalManifest(manifest)
    expect(pack.actions).toHaveLength(1)
    expect(pack.actions[0]!.binding).toEqual({
      kind: 'external',
      sourceId: 'ext.catalog.lookup',
      remoteName: 'search_assets',
    })
    expect(registry.validateInput('ext.catalog.search', { query: 'cherry' })).toEqual({ ok: true, data: { query: 'cherry' } })
    expect(registry.validateInput('ext.catalog.search', { query: 'cherry', extra: 1 }).ok).toBe(false)
    expect(registry.listActions({ includeExternal: false }).some((item) => item.id === 'ext.catalog.search')).toBe(false)

    // Digest tampering is rejected.
    expect(() =>
      registry.registerExternalManifest({
        ...manifest,
        sourceId: 'ext.catalog.tampered',
        allow: [{ ...manifest.allow[0]!, localId: 'ext.catalog.tampered_search', inputDigest: `sha256:${'0'.repeat(64)}` }],
      }),
    ).toThrow(/digest mismatch/)

    // Colliding with an existing built-in capability id is rejected without mutating the registry.
    expect(() =>
      registry.registerExternalManifest({
        ...manifest,
        sourceId: 'ext.catalog.collide',
        allow: [{ ...manifest.allow[0]!, localId: 'studio.board.read_context' }],
      }),
    ).toThrow(/Duplicate capability action id/)
    expect(registry.getPack('ext.catalog.collide')).toBeUndefined()

    // Unregistering cleans up both pack and actions.
    expect(registry.unregisterPack('ext.catalog.lookup')).toBe(true)
    expect(registry.getAction('ext.catalog.search')).toBeUndefined()
  })

  it('synthesizes deterministic skill markdown ordered by fragment order and filtered by active actions', () => {
    const registry = createCapabilityRegistry(STUDIO_CAPABILITY_PACKS)
    const readOnlySkill = registry.synthesizeSkill({ enabledPacks: ['studio.board.read'] })
    expect(readOnlySkill.fragmentIds).toEqual(['studio.skill.read'])
    expect(readOnlySkill.markdown).toContain('studio_read_context')
    expect(readOnlySkill.markdown).not.toContain('studio_generate')

    const fullSkill = registry.synthesizeSkill({ surface: '/studio' })
    expect(fullSkill.fragmentIds).toEqual([
      'studio.skill.read',
      'studio.skill.cards',
      'studio.skill.regions',
      'studio.skill.sampling',
      'studio.skill.wires',
      'studio.skill.runs',
      'studio.skill.ask',
    ])
    expect(fullSkill.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
