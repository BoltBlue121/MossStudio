export {
  CAPABILITY_ID_PATTERN,
  CAPABILITY_PROTOCOL_VERSION,
  canonicalJson,
  capabilityIdSchema,
  descriptorFromContribution,
  externalToolManifestSchema,
  isCapabilityId,
  packDescriptorFromBuiltin,
  packFromExternalManifest,
  schemaDigest,
  sha256Text,
  toClosedJsonSchema,
  type ActionBinding,
  type ActionDescriptor,
  type ActionEffect,
  type ActionRequirement,
  type ActionScope,
  type ActionTarget,
  type BuiltinActionContribution,
  type BuiltinCapabilityPack,
  type CapabilityId,
  type CapabilityPack,
  type CapabilitySurface,
  type ContextProviderDescriptor,
  type DiscoveredExternalTool,
  type ExternalToolAllowEntry,
  type ExternalToolManifest,
  type Json,
  type JsonSchema,
  type LegacyAgentPack,
  type PolicyGate,
  type SkillAudience,
  type SkillFragment,
} from './protocol'

export {
  createCapabilityRegistry,
  explainZodIssues,
  type CapabilityQuery,
  type CapabilityRegistry,
  type RegisteredAction,
  type SkillSynthesisOptions,
  type SynthesizedSkill,
  type ToolDefinitionOptions,
  type ValidationResult,
} from './registry'

export {
  LEGACY_TOOL_ORDER,
  STUDIO_ACTION_SCHEMAS,
  STUDIO_CAPABILITY_PACKS,
  createStudioCapabilityRegistry,
  type StudioActionArgs,
  type StudioActionId,
} from './studioPacks'

import { createStudioCapabilityRegistry } from './studioPacks'

/** Default shared registry containing every built-in MossStudio capability pack. */
export const BUILTIN_CAPABILITY_REGISTRY = createStudioCapabilityRegistry()
