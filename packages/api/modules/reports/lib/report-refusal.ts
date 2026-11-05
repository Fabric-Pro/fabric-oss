type ReportGenerationErrorCode = "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST";

/**
 * A refusal written for the person, raised before anything was written or
 * admitted. The report procedures turn it into their error; Fabric Agent's
 * report tools return its message.
 */
export class ReportGenerationError extends Error {
	constructor(
		readonly code: ReportGenerationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ReportGenerationError";
	}
}
