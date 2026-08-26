/**
 * Validation module exports
 */

export {
	type ValidationError,
	type ValidationResult,
	type ValidationWarning,
	validateDocument,
} from "./document-validator";
export {
	checkFormatting,
	type FormattingError,
} from "./formatting-checker";
export {
	getSectionNames,
	hasRequiredSections,
	type ParsedHeading,
	type ParsedSection,
	parseHeadings,
	parseSections,
	validateHeadingHierarchy,
} from "./markdown-parser";
export {
	type DetectDroppedSectionsOptions,
	type DroppedSection,
	detectDroppedSections,
} from "./section-preservation";
