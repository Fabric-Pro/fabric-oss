/**
 * Documentation-shaped view of an OpenAPI/Swagger document.
 *
 * Deliberately separate from `ParsedOpenAPISpec` in `types.ts`. That one exists
 * to make an API *callable*: it keeps one response schema per operation, drops
 * every other status code, and dereferences `$ref`s so each tool carries a
 * self-contained input schema. Correct for execution, wrong for description —
 * dereferencing a shared `Error` model across 300 operations writes it out 300
 * times, so the "summary" ends up larger than the file it summarizes.
 *
 * This view answers "what does this API look like": every status code, models
 * listed once and referenced by name, and enough per-operation detail that a
 * single operation retrieved on its own still makes sense.
 */

/** Where a parameter travels. */
export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface ParameterDescription {
	name: string;
	in: ParameterLocation;
	required: boolean;
	type: string;
	description: string | null;
	/** Allowed values, when the schema constrains them. */
	enumValues?: string[];
}

export interface RequestBodyDescription {
	required: boolean;
	description: string | null;
	contentTypes: string[];
	/** Model name when the body is a `$ref`, else null. */
	schemaRef: string | null;
	/** Compact inline shape when the body is not a `$ref`, else null. */
	schemaSummary: string | null;
}

export interface ResponseDescription {
	/** "200", "404", "default" — kept as written, not coerced to a number. */
	statusCode: string;
	description: string | null;
	contentTypes: string[];
	schemaRef: string | null;
	schemaSummary: string | null;
}

export interface OperationDescription {
	operationId: string;
	/** Upper-case. */
	method: string;
	path: string;
	summary: string | null;
	description: string | null;
	tags: string[];
	deprecated: boolean;
	parameters: ParameterDescription[];
	requestBody: RequestBodyDescription | null;
	/** Every declared response, not just the success one. */
	responses: ResponseDescription[];
	/** Names of security schemes this operation requires. */
	security: string[];
}

export interface ModelPropertyDescription {
	name: string;
	type: string;
	required: boolean;
	description: string | null;
	/**
	 * Allowed values, when the schema constrains them.
	 *
	 * Carried for the same reason response codes are: an enum IS the contract for
	 * that field. Dropping it hands the model `status: string` for something the
	 * API will reject unless it is one of three exact values.
	 */
	enumValues?: string[];
}

export interface ModelDescription {
	name: string;
	description: string | null;
	properties: ModelPropertyDescription[];
}

export interface SecuritySchemeSummary {
	name: string;
	type: string;
	/** "header"/"query"/"cookie" for apiKey schemes. */
	in?: string;
	/** "bearer"/"basic" for http schemes. */
	scheme?: string;
}

export interface OpenApiDescription {
	/** The document's own version string: "3.0.3", "3.1.0", "2.0". */
	specVersion: string;
	title: string;
	version: string;
	description: string | null;
	/** Fully composed server URLs. Swagger 2.0's host/basePath/schemes are joined here. */
	servers: string[];
	securitySchemes: SecuritySchemeSummary[];
	operations: OperationDescription[];
	/** `components.schemas` (3.x) or `definitions` (2.0), listed once. */
	models: ModelDescription[];
	/**
	 * Paths whose definition lives in another file, so their operations could not
	 * be read. Recorded rather than dropped: a multi-file spec that `$ref`s out to
	 * `./paths/pets.yaml` would otherwise lose those endpoints from the inventory
	 * with nothing saying so, which is the silent loss this whole feature exists
	 * to stop.
	 */
	unresolvedPaths: string[];
}

/**
 * Outcome of asking "is this an OpenAPI document?".
 *
 * The three-way split is what lets two requirements coexist: a `.json` file that
 * simply isn't a spec must fall through to ordinary text handling without
 * comment, while a file that declares itself a spec and then fails to parse must
 * be reported. Collapsing these into a boolean forces one of them to be wrong.
 */
export type SpecDetection =
	| { kind: "spec"; specVersion: string }
	| { kind: "not-a-spec" }
	| { kind: "malformed"; reason: string };

/** Raised when `describeOpenApiSpec` is handed something it cannot describe. */
export class OpenApiDescribeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenApiDescribeError";
	}
}
