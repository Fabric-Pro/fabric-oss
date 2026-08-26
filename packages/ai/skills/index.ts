/**
 * @repo/ai/skills — runtime for Anthropic-format Agent Skills, backed by
 * Fabric's Skill + SkillFile catalog and S3 storage.
 */

export {
	invalidateSkillCache,
	isTextContentType,
	listAvailableSkills,
	loadSkillBundle,
	MAX_SKILL_FILE_READ_BYTES,
	readSkillFile,
	type SkillBundle,
	type SkillContext,
	type SkillFileContent,
	type SkillFileManifestEntry,
	type SkillSummary,
	stripFrontmatter,
} from "./loader";
export { buildSkillsSystemBlock } from "./prompt-fragment";
export { createSkillTools } from "./tools";
