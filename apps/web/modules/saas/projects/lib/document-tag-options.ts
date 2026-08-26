/**
 * Shared document tag options for file/context uploads.
 * Used by WizardFileUploader, WizardIntegrationsSection, and ContextUploaderDialog.
 */
export const DOCUMENT_TAG_OPTIONS = [
	{ value: "", label: "Context only" },
	{ value: "PRD", label: "PRD" },
	{ value: "PROPOSAL", label: "Proposal" },
	{ value: "BUSINESS_CASE", label: "Business Case" },
	{ value: "ARCHITECTURE", label: "Architecture" },
	{ value: "TECHNICAL_SPEC", label: "Technical Spec" },
	{ value: "API_SPEC", label: "API Spec" },
	{ value: "USER_STORY", label: "Features" },
] as const;
