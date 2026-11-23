/*
 * The two guides below combine the official MOSS-Image prompt-enhancer skill
 * (skills/moss-image-prompt-enhancer/SKILL.md and references/layout.md in
 * https://github.com/OpenMOSS/MOSS-Image, Apache License 2.0) with original
 * MossStudio engineering rules tailored to MOSS-Image's unidirectional
 * Qwen3.5-9B text encoder, 5B single-stream DiT, and MossStudio's live board
 * tools. Each guide stands alone as a toggleable Skill pack (`skill.moss.standard`
 * for pure Caption workflows, `skill.moss.layout` for region/Layout workflows).
 */
export const MOSS_PROMPTCRAFT_SKILL_MD = String.raw`# MOSS Promptcraft Skill (Standard Caption Mode)

Adapted from https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/SKILL.md (Apache License 2.0) with MossStudio prompt-engineering rules for Qwen3.5-9B + 5B DiT.

## 1. Unidirectional Causal Ordering (Macro -> Micro)
MOSS-Image encodes text through a unidirectional causal language model (Qwen3.5-9B): later tokens attend to earlier ones, never the reverse. Always write prompts in strict macro-to-micro order so lighting and medium govern everything downstream:
1. **Medium, art style & camera framing**: lead with the visual medium, style era/technique, focal feel, camera angle, and shot scale (e.g. "High-taste 2D digital painting with selective focus, medium three-quarter shot, slight low angle" or "Candid 35mm film photograph, harsh direct on-camera flash, deep depth of field").
2. **Environment & global lighting**: establish setting, key light direction/temperature, fill/rim light, and shadow behavior BEFORE describing skin or fabric. For dark rooms or backlit silhouettes, state front-body shadows explicitly and omit "fair/bright skin" words that force flat front fill.
3. **Subject pose, orientation & gaze**: state exact body/head orientation ("viewer left", "her right hand"), physical contact points, and subtle expression.
4. **Layered attire & visible materials**: describe garments from outer layer inward with tangible surface response (matte weave, translucent chiffon, specular leather, damp sheen) rather than cluttered micro-patterns.
5. **Background props & palette anchor**: finish with secondary props and a restrained 2-4 color harmony (or explicit hex palette such as "Dominant palette: #1e293b, #f8fafc, accent #f59e0b").

## 2. Visible Phenomena Only — What Works vs What Fails
- **Describe visible optical/painterly results, never bare gear or engine names**: training captions describe what the eye sees, not camera bodies or renderers. Bare tags like "Contax T2", "Unreal Engine 5", or "Octane Render" have negligible effect unless paired with visible traits (hard flash drop shadows, film grain, gouache brushwork, cel-shaded hard shadows).
- **Drop unindexed personal artist handles**: generic Danbooru artist handles ("xxx style") are largely absent from VLM recaptions and waste tokens unless backed by an active LoRA trigger word from \`models.catalog.installed\` or \`remote.hosts.loras_list\`. Keep recognizable character names when fidelity helps, and strip broad franchise/company tags that induce cheap cosplay-wig artifacts.
- **Selective focus & finish**: concentrate crisp detail on eyes, eyelashes, lips, hair wisps, and hands while allowing breathable brushwork or natural depth-of-field falloff on secondary clothing folds and backgrounds; this avoids both unfinished-sketch faces and over-sharpened plastic skin.
- **Closed \`<|block|>...<|/block|>\` tags for multi-subject scenes**: for compact single-subject scenes, write one cohesive English paragraph (around 60-120 words). When two or more subjects or distinct depth layers share a pure Caption without region boxes, wrap each subject/layer on its own line (\`<|camera_and_lighting|>...<|/camera_and_lighting|>\`, \`<|left_subject|>...<|/left_subject|>\`, \`<|right_subject|>In sharp contrast, NO ...<|/right_subject|>\`), grouping all attributes of one character inside their own block and adding explicit "In sharp contrast, NO <neighbor trait>" anchors to prevent feature bleed.
- **Exact visible text**: quote any intended visible text verbatim in its original language, preserving punctuation, casing, and line breaks; never use placeholders like "headline here" and never leak JSON/tool/coordinate notes into the prompt.

## 3. MossStudio Standard Caption Workflow
1. Call \`studio.board.read_context\` (or \`studio_read_context\`) first to inspect the selected Canvas, size, prompt, regions, model, and LoRAs.
2. Check \`models.catalog.installed\` (or \`remote.hosts.loras_list\` when running on a Worker host) before changing models or LoRAs; honor each active LoRA's real trigger words and model defaults (e.g. 16 steps / CFG 3 on Heal or distilled 8-step CFG 1 on Turbo, 20-50 steps / CFG 3-4 on standard SFT).
3. In Standard Caption mode, keep the Canvas region list empty (or clear stale regions when switching from Layout to pure Caption) and write the positive prompt via \`studio.board.set_prompt\`. Set \`negative\` only when needed (concise quality/anatomy/style exclusions, omitting \`text\` when rendering words).
4. Verify readiness via \`studio.board.diagnose\`, then start generation with \`studio.runs.generate\` when requested by the user.`

export const MOSS_LAYOUT_DESIGN_SKILL_MD = String.raw`# MOSS Layout Design Skill (Spatial Region Mode)

Adapted from https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/references/layout.md (Apache License 2.0) with MossStudio spatial-composition rules.

## 1. When and How Layout Mode Works in MossStudio
- Use Layout mode whenever spatial control matters: multi-character staging, posters, typography/signage, comics/multi-panel pages, asymmetric compositions, or exact object-to-character relationships. Even a single-subject scene can use Layout to lock framing, scale, and negative space.
- MossStudio stores the global scene description on the Canvas prompt (\`summary.caption\`) and stores spatial items as Canvas regions (\`object\`, \`character\`, \`text\`). When generating, MossStudio's built-in compiler automatically converts normalized \`0..1\` \`{x, y, w, h}\` boxes on the active \`width × height\` (multiples of 16, up to 4.2 MP) into MOSS-Image's centered integer \`abs_centralized\` / \`yxyx\` JSON.
- **Never** hand-write raw Layout JSON into \`studio.board.set_prompt\`, **never** compute \`abs_centralized\` / \`yxyx\` coordinates by hand, and **never** invoke external \`compile_prompt.py\` scripts. Always use \`studio.regions.add\`, \`studio.regions.add_text\`, \`studio.regions.update\`, and \`studio.regions.remove\`.

## 2. Global Summary vs Per-Region Captions
- **Global Canvas prompt (\`studio.board.set_prompt\`)**: acts as \`summary.caption\`. Lead with overall medium, art style, lighting, color harmony, and—for multi-panel or recurring characters—a concise character appearance sheet so unidirectional attention propagates consistent traits into every region below.
- **Region labels (\`character\` vs \`object\` vs \`text\`)**:
  - Use \`character\` ONLY for regions containing a person/creature with a head/body. For inset close-ups of eyes, lips, hands, shoes, or props, use \`object\` and start the caption with \`Extreme close-up showing ONLY ...\` so the model does not hallucinate an extra head inside the inset box.
  - Separate two characters into two distinct \`character\` regions with clear horizontal/vertical separation or intentional overlap, repeating core hair/eye/outfit anchors in each region caption so traits never swap.
  - A bounding box is a placement guide, NOT a drawn frame, card, or sticker; natural overlap and occlusion between boxes are supported. Make sure spatial words in captions ("on the left", "in the upper right") agree with their box coordinates.
- **Typography & comic speech bubbles (\`studio.regions.add_text\`)**:
  - \`caption\` describes ONLY typography, lettering style, color, surface/container, and bubble geometry—never the rendered words themselves.
  - \`text\` holds the exact characters to render (with \`\n\` for intended line breaks and no surrounding quotes).
  - For comic/dialogue bubbles, disambiguate speaker attribution via geometry and pointer direction:
    - Spoken by an on-screen character: place the box near that speaker's head (>=80 px away from other heads) and write \`Clean [vertical/horizontal] [Chinese/English] spoken dialogue inside a rounded oval comic speech bubble with a pointer tail pointing [down/left/right] toward [Character]'s head\`.
    - Off-screen / POV monologue: write \`inside a tail-less oval thought bubble (smooth outline with NO pointer tail pointing to any character)\`.
    - Narration / title / label box: write \`inside a sharp-cornered rectangular narration box (no bubble tail)\`—never write the literal word "旁白" into \`text\`.
    - In vertical CJK bubbles, write multi-digit numbers in CJK numerals (e.g. \`二十八岁\`, \`七百二十\`) and omit ASCII spaces inside CJK names to prevent vertical glyph collisions.
  - Leave generous breathing room inside text boxes; for multi-panel pages, align sibling panel top edges and prefer \`waist-up\` or \`thigh-up medium shot\` in small panels so characters do not shrink into chibi proportions.

## 3. MossStudio Layout Workflow & Revision Discipline
1. Read the current Canvas with \`studio.board.read_context\`. Pick Canvas dimensions first (\`studio.sampling.set\`, multiples of 16 matching the intended aspect ratio and pixel tier; prefer >=1.5 MP and higher steps for dense small text).
2. Write the global scene/style summary via \`studio.board.set_prompt\`, then populate or refine regions via \`studio.regions.add\` (\`label: "character" | "object"\`, normalized \`0..1\` \`box: { x, y, w, h }\`) and \`studio.regions.add_text\` (\`caption\` + exact \`text\` + \`box\`).
3. Run \`studio.board.diagnose\` after every geometry or text edit to verify compiled Layout validity and resolve any bounds/empty-text errors before calling \`studio.runs.generate\`.
4. When revising an existing Canvas on a fixed seed, preserve \`summary.caption\` and untouched regions, updating only the specific region indices (\`studio.regions.update\`) that need adjustment so character identity and composition stay stable.`

export type GuideTopic = 'all' | 'tools' | 'promptcraft' | 'layout'

export function composeOfficialGuide(tools: string, topic: GuideTopic = 'all'): string {
  if (topic === 'tools') return tools
  if (topic === 'promptcraft') return MOSS_PROMPTCRAFT_SKILL_MD
  if (topic === 'layout') return MOSS_LAYOUT_DESIGN_SKILL_MD
  const extra = [
    !tools.includes('# MOSS Promptcraft Skill') ? MOSS_PROMPTCRAFT_SKILL_MD : '',
    !tools.includes('# MOSS Layout Design Skill') ? MOSS_LAYOUT_DESIGN_SKILL_MD : '',
  ].filter(Boolean)
  return [tools, ...extra].join('\n\n')
}
