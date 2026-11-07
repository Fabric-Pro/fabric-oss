/** Fabric's bounded JSON schema subset. Remote references, regex and executable extensions are unsupported. */
export interface ResultJsonSchema {
	type:
		| "object"
		| "array"
		| "string"
		| "number"
		| "integer"
		| "boolean"
		| "null";
	properties?: Record<string, ResultJsonSchema>;
	required?: string[];
	additionalProperties?: false;
	items?: ResultJsonSchema;
	enum?: Array<string | number | boolean | null>;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
}
export interface ResultQualityChecks {
	version?: 1 | 2;
	requiredPhrases?: string[];
	forbiddenPhrases?: string[];
	/** Richer checks require version:2. Maximum64 schema nodes, depth8. */
	jsonSchema?: ResultJsonSchema;
	jsonAssertions?: Array<{
		pointer: string;
		type?: ResultJsonSchema["type"];
		equals?: string | number | boolean | null;
		minimum?: number;
		maximum?: number;
	}>;
	/** Reports Not assessed until trusted runtime retrieval evidence is available. */
	grounding?: { requireCitations: true };
}
export interface ResultQualityGrade {
	version: 2;
	method: "deterministic";
	scorerVersion: "fabric-deterministic-v1";
	status: "PASSED" | "FAILED" | "NOT_ASSESSED";
	passed: number;
	total: number;
	unavailable: number;
	results: Array<{
		kind: "required" | "forbidden" | "json" | "schema" | "grounding";
		index: number;
		passed: boolean;
		available: boolean;
	}>;
}
