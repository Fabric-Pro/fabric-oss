/** Fixed-origin read transport shared by project roster, counts and story snapshots. */
export interface AzureDevOpsProjectTarget {
	organization: string;
	projectId: string;
}

export class AzureDevOpsProjectReadError extends Error {
	constructor(
		public readonly code:
			| "authentication"
			| "permission"
			| "unavailable"
			| "invalid_response"
			| "invalid_filter"
			| "unsupported_current_predicate"
			| "project_mismatch",
	) {
		super(
			{
				authentication:
					"Reconnect Azure DevOps: its credential was rejected.",
				permission:
					"The Azure DevOps connection cannot read this project's teams or work items.",
				unavailable:
					"Azure DevOps could not complete the project read. Try again.",
				invalid_response:
					"Azure DevOps returned an unexpected project response.",
				invalid_filter:
					"An Azure DevOps filter cannot contain control characters or both single and double quotes.",
				unsupported_current_predicate:
					"An Azure DevOps assignment field does not support current-user identity filtering. Select an exact member identity instead.",
				project_mismatch:
					"An Azure DevOps work item does not belong to the connected project.",
			}[code],
		);
	}
}

export class ReadBudgetExceeded extends Error {
	constructor(
		public readonly reason:
			| "request_limit"
			| "time_limit"
			| "response_limit"
			| "total_response_limit"
			| "character_limit"
			| "page_limit"
			| "item_limit",
	) {
		super("The Azure DevOps read exceeded its bounded capture budget.");
	}
}

export function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return Object.fromEntries(Object.entries(value));
}

export function stringField(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 512) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return value;
}

export function listField(value: unknown): unknown[] {
	if (!Array.isArray(value)) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return value;
}

export function pathSegment(value: unknown): string {
	const segment = stringField(value);
	if (
		segment === "." ||
		segment === ".." ||
		/[\u0000-\u001f\u007f]/.test(segment)
	) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return encodeURIComponent(segment);
}

/** The stored organization is a name, never a caller URL. */
export function azureDevOpsOrganization(
	commandArgs: readonly string[],
): string | null {
	const organization = commandArgs[0]?.trim();
	return organization && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/.test(organization)
		? organization
		: null;
}

export function wiqlLiteral(value: string): string {
	if (
		/[\u0000-\u001f\u007f]/.test(value) ||
		(value.includes("'") && value.includes('"'))
	) {
		throw new AzureDevOpsProjectReadError("invalid_filter");
	}
	return value.includes("'") ? `"${value}"` : `'${value}'`;
}

interface ProjectReadBodyLimits {
	responseBytes: number;
	totalBytes: number;
	totalCharacters: number;
}

export function projectReader(
	target: AzureDevOpsProjectTarget,
	pat: string,
	limits?: ProjectReadBodyLimits,
) {
	if (
		!azureDevOpsOrganization([target.organization]) ||
		!target.projectId ||
		target.projectId.length > 256 ||
		target.projectId === "." ||
		target.projectId === ".." ||
		/[\u0000-\u001f\u007f]/.test(target.projectId)
	) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	const origin = `https://dev.azure.com/${encodeURIComponent(target.organization)}`;
	const deadline = Date.now() + 25_000;
	let remaining = 40;
	let totalBytes = 0;
	let totalCharacters = 0;
	async function boundedBody(response: Response) {
		if (!limits) {
			const body: unknown = await response.json();
			return record(body);
		}
		if (!response.body) {
			throw new AzureDevOpsProjectReadError("invalid_response");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let bytes = 0;
		let text = "";
		try {
			for (;;) {
				const chunk = await reader.read();
				if (Date.now() >= deadline) {
					throw new ReadBudgetExceeded("time_limit");
				}
				if (chunk.done) {
					break;
				}
				bytes += chunk.value.byteLength;
				totalBytes += chunk.value.byteLength;
				if (bytes > limits.responseBytes) {
					throw new ReadBudgetExceeded("response_limit");
				}
				if (totalBytes > limits.totalBytes) {
					throw new ReadBudgetExceeded("total_response_limit");
				}
				const decoded = decoder.decode(chunk.value, { stream: true });
				totalCharacters += decoded.length;
				if (totalCharacters > limits.totalCharacters) {
					throw new ReadBudgetExceeded("character_limit");
				}
				text += decoded;
			}
			const tail = decoder.decode();
			totalCharacters += tail.length;
			if (totalCharacters > limits.totalCharacters) {
				throw new ReadBudgetExceeded("character_limit");
			}
			const body: unknown = JSON.parse(text + tail);
			return record(body);
		} catch (error) {
			if (error instanceof SyntaxError || error instanceof TypeError) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			throw error;
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}
	return async (
		path: string,
		params: Record<string, string>,
		query?: string,
	) => {
		const timeout = Math.min(10_000, deadline - Date.now());
		if (timeout <= 0) {
			throw new ReadBudgetExceeded("time_limit");
		}
		if (remaining-- <= 0) {
			throw new ReadBudgetExceeded("request_limit");
		}
		const url = new URL(`${origin}/${path}`);
		url.search = new URLSearchParams({
			"api-version": "7.1",
			...params,
		}).toString();
		try {
			const response = await fetch(url, {
				method: query === undefined ? "GET" : "POST",
				redirect: "error",
				signal: AbortSignal.timeout(timeout),
				headers: {
					Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
					Accept: "application/json",
					...(query === undefined
						? {}
						: { "Content-Type": "application/json" }),
				},
				...(query === undefined
					? {}
					: { body: JSON.stringify({ query }) }),
			});
			if (
				response.status === 203 ||
				response.status === 401 ||
				response.headers.get("content-type")?.includes("text/html")
			) {
				throw new AzureDevOpsProjectReadError("authentication");
			}
			if (response.status === 403) {
				throw new AzureDevOpsProjectReadError("permission");
			}
			if (!response.ok) {
				throw new AzureDevOpsProjectReadError("unavailable");
			}
			return await boundedBody(response);
		} catch (error) {
			if (
				error instanceof AzureDevOpsProjectReadError ||
				error instanceof ReadBudgetExceeded
			) {
				throw error;
			}
			if (limits && Date.now() >= deadline) {
				throw new ReadBudgetExceeded("time_limit");
			}
			throw new AzureDevOpsProjectReadError("unavailable");
		}
	};
}

export type AzureDevOpsCaptureIncompleteReason =
	| ReadBudgetExceeded["reason"]
	| "unavailable"
	| "invalid_response"
	| "concurrent_changes";

export function captureIncompleteReason(
	error: unknown,
): AzureDevOpsCaptureIncompleteReason {
	if (error instanceof ReadBudgetExceeded) {
		return error.reason;
	}
	if (
		error instanceof AzureDevOpsProjectReadError &&
		(error.code === "unavailable" || error.code === "invalid_response")
	) {
		return error.code;
	}
	throw error;
}

export function positiveInteger(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value <= 0
	) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return value;
}

export function dateField(value: unknown): string {
	const date = stringField(value);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/i.test(
			date,
		) ||
		!Number.isFinite(Date.parse(date))
	) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return date;
}

export async function readCanonicalProject(
	read: ReturnType<typeof projectReader>,
	target: AzureDevOpsProjectTarget,
) {
	const body = await read(
		`_apis/projects/${pathSegment(target.projectId)}`,
		{},
	);
	const project = { id: stringField(body.id), name: stringField(body.name) };
	const requested = target.projectId.toLowerCase();
	if (
		project.id.toLowerCase() !== requested &&
		project.name.toLowerCase() !== requested
	) {
		throw new AzureDevOpsProjectReadError("project_mismatch");
	}
	return project;
}

export function storyProjectReader(
	target: AzureDevOpsProjectTarget,
	pat: string,
) {
	return projectReader(target, pat, {
		responseBytes: 2 * 1024 * 1024,
		totalBytes: 8 * 1024 * 1024,
		totalCharacters: 6 * 1024 * 1024,
	});
}
