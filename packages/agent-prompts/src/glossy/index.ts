/**
 * Glossy edition prompts (Fizzy #2589, KTD13, KTD14).
 *
 * Glossy prompts are internal transformations that no user binds or edits,
 * so they live in code rather than in the seeded prompt registry, versioned
 * by `GLOSSY_PIPELINE_VERSION`. Pure strings and builders: the model calls,
 * output schemas, and guards live in @repo/temporal (src/lib/glossy).
 */

/**
 * Enters every Glossy cache key (KTD8, KTD14). Bump it whenever a prompt or
 * output schema here or in packages/temporal/src/lib/glossy changes in a way
 * that could change model output, so cached rewrites, detections, and
 * extractions are recomputed rather than reused.
 */
export const GLOSSY_PIPELINE_VERSION = "2026-09-24.1";

export {
	buildGlossyDetectInstructions,
	buildGlossyDetectPrompt,
	GLOSSY_DETECTABLE_KINDS,
	GLOSSY_DETECTION_SECTION_MAX_CHARS,
	GLOSSY_KIND_DEFINITIONS,
	GLOSSY_MAX_OPPORTUNITIES,
	GLOSSY_REASON_MAX_CHARS,
	type GlossyDetectableKind,
	type GlossyDetectPromptSection,
} from "./detect";
export {
	buildGlossyExtractInstructions,
	buildGlossyExtractPrompt,
	GLOSSY_EXTRACTION_SECTION_MAX_CHARS,
	GLOSSY_KIND_FIELD_RULES,
	GLOSSY_SLOT_HINT_MAX_CHARS,
	GLOSSY_STYLE_DIRECTION_MAX_CHARS,
	type GlossyExtractPromptInput,
	type GlossyExtractPromptKind,
} from "./extract";
export {
	buildGlossyRewriteInstructions,
	buildGlossyRewritePrompt,
	type GlossyRewriteFinding,
	type GlossyRewriteLengthMode,
	type GlossyRewritePromptInput,
	glossyMeasuredLength,
} from "./rewrite";
export {
	boundGlossyField,
	GLOSSY_SECTION_TAG,
	GLOSSY_UNTRUSTED_GUIDANCE,
	GLOSSY_UNTRUSTED_TAG,
	type GlossyUntrustedSection,
	type GlossyUntrustedSource,
	glossyDocumentLabel,
	neutralizeGlossyTags,
	truncateCodePoints,
	wrapGlossyDocument,
	wrapGlossyUntrusted,
} from "./untrusted";
