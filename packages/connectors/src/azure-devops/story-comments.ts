import {
	type AzureDevOpsCaptureIncompleteReason,
	AzureDevOpsProjectReadError,
	captureIncompleteReason,
	dateField,
	listField,
	positiveInteger,
	type projectReader,
	ReadBudgetExceeded,
	record,
} from "./project-read";

export interface AzureDevOpsStoryComment {
	id: number;
	version: number;
	modifiedDate: string;
	isDeleted: boolean;
	fullText: string | null;
	format: "html" | "markdown" | null;
}

export interface AzureDevOpsStoryCommentsCapture {
	comments: AzureDevOpsStoryComment[];
	complete: boolean;
	incompleteReason: AzureDevOpsCaptureIncompleteReason | null;
	captureStartedAt: string;
	capturedAt: string;
	consistency: "two_matching_reads" | "unconfirmed";
	atomicAsOf: false;
}

class ConcurrentCommentChange extends Error {}

function parseComment(raw: unknown, itemId: number): AzureDevOpsStoryComment {
	const value = record(raw);
	const id = positiveInteger(value.id ?? value.commentId);
	if (
		(value.id !== undefined &&
			value.commentId !== undefined &&
			value.id !== value.commentId) ||
		value.workItemId !== itemId ||
		typeof value.isDeleted !== "boolean" ||
		(value.text !== undefined &&
			value.text !== null &&
			typeof value.text !== "string") ||
		(!value.isDeleted && typeof value.text !== "string") ||
		(value.format !== undefined &&
			value.format !== null &&
			value.format !== "html" &&
			value.format !== "markdown")
	) {
		throw new AzureDevOpsProjectReadError("invalid_response");
	}
	return {
		id,
		version: positiveInteger(value.version),
		modifiedDate: dateField(value.modifiedDate),
		isDeleted: value.isDeleted,
		fullText: typeof value.text === "string" ? value.text : null,
		format:
			value.format === "html" || value.format === "markdown"
				? value.format
				: null,
	};
}

/** Comments have no ASOF API. Two full matching reads detect changes during capture. */
export async function readStableStoryComments(
	read: ReturnType<typeof projectReader>,
	projectPath: string,
	itemId: number,
): Promise<AzureDevOpsStoryCommentsCapture> {
	const captureStartedAt = new Date().toISOString();
	let comments: AzureDevOpsStoryComment[] = [];
	let incompleteReason: AzureDevOpsCaptureIncompleteReason | null = null;
	async function pass() {
		const collected = new Map<number, AzureDevOpsStoryComment>();
		const seenTokens = new Set<string>();
		let token: string | null = null;
		let total: number | null = null;
		for (let page = 0; page < 20; page++) {
			const body = await read(
				`${projectPath}/_apis/wit/workItems/${itemId}/comments`,
				{
					"api-version": "7.1-preview.4",
					$top: "100",
					includeDeleted: "true",
					order: "asc",
					...(token ? { continuationToken: token } : {}),
				},
			);
			if (
				typeof body.totalCount !== "number" ||
				!Number.isSafeInteger(body.totalCount) ||
				body.totalCount < 0
			) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			if (total !== null && total !== body.totalCount) {
				throw new ConcurrentCommentChange();
			}
			total = body.totalCount;
			if (total > 1_000) {
				throw new ReadBudgetExceeded("item_limit");
			}
			const values = listField(body.comments);
			if (values.length > 100 || body.count !== values.length) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			for (const raw of values) {
				const comment = parseComment(raw, itemId);
				if (collected.has(comment.id)) {
					throw new AzureDevOpsProjectReadError("invalid_response");
				}
				collected.set(comment.id, comment);
			}
			const next = body.continuationToken;
			if (next === undefined || next === null || next === "") {
				if (
					(body.nextPage !== undefined &&
						body.nextPage !== null &&
						body.nextPage !== "") ||
					collected.size !== total
				) {
					throw new AzureDevOpsProjectReadError("invalid_response");
				}
				return [...collected.values()].sort((a, b) => a.id - b.id);
			}
			if (
				typeof next !== "string" ||
				next.length > 4_096 ||
				seenTokens.has(next) ||
				values.length === 0
			) {
				throw new AzureDevOpsProjectReadError("invalid_response");
			}
			seenTokens.add(next);
			token = next;
		}
		throw new ReadBudgetExceeded("page_limit");
	}
	try {
		comments = await pass();
		const confirmed = await pass();
		if (JSON.stringify(comments) !== JSON.stringify(confirmed)) {
			throw new ConcurrentCommentChange();
		}
	} catch (error) {
		incompleteReason =
			error instanceof ConcurrentCommentChange
				? "concurrent_changes"
				: captureIncompleteReason(error);
	}
	return {
		comments,
		complete: incompleteReason === null,
		incompleteReason,
		captureStartedAt,
		capturedAt: new Date().toISOString(),
		consistency:
			incompleteReason === null ? "two_matching_reads" : "unconfirmed",
		atomicAsOf: false,
	};
}
