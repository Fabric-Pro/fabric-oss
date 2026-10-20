import { createHash } from "node:crypto";
import { redactLogText } from "@repo/utils/log-redaction";
import { keyIsSensitive } from "@repo/utils/sensitive-keys";
import { z } from "zod";
import type { AgentToolSource } from "./shared/agent-tool-runtime";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** What a tool says about how it ended, as opposed to what it created or returned. */
function outcomeText(result: object): string {
	const parts: unknown[] = [];
	if ("error" in result) {
		parts.push(
			typeof result.error === "string"
				? result.error
				: JSON.stringify(result.error),
		);
	}
	if ("message" in result) {
		parts.push(result.message);
	}
	if (
		"isError" in result &&
		result.isError === true &&
		"content" in result &&
		Array.isArray(result.content)
	) {
		parts.push(
			...result.content.map((part: unknown) =>
				typeof part === "object" && part !== null && "text" in part
					? part.text
					: undefined,
			),
		);
	}
	return parts.filter((part) => typeof part === "string").join(" ");
}

const CREATED_RESOURCE_KEYS = ["storyId", "identifier", "id", "url"];

/** A result that names the thing it made, such as a work item's id and link. */
function namesCreatedResource(result: object): boolean {
	return CREATED_RESOURCE_KEYS.some((key) => {
		const value = (result as Record<string, unknown>)[key];
		return typeof value === "string" && value.length > 0;
	});
}

export function parlumeActionOutcome(
	result: unknown,
): "COMPLETED" | "FAILED" | "OUTCOME_UNKNOWN" {
	if (typeof result !== "object" || result === null) {
		return "OUTCOME_UNKNOWN";
	}
	if (
		/timed? ?out|timeout|did not respond|connection (?:lost|closed)|aborted|cancelled after/i.test(
			outcomeText(result),
		)
	) {
		return "OUTCOME_UNKNOWN";
	}
	if (
		("requiresConfirmation" in result && result.requiresConfirmation) ||
		("authorityRequired" in result && result.authorityRequired)
	) {
		return "FAILED";
	}
	if (
		"status" in result &&
		typeof result.status === "string" &&
		/^(?:queued|pending|running|accepted|submitted|unconfirmed|in_progress)$/i.test(
			result.status,
		)
	) {
		return "OUTCOME_UNKNOWN";
	}
	if (
		("error" in result && result.error) ||
		("success" in result && result.success === false) ||
		("isError" in result && result.isError === true)
	) {
		return "FAILED";
	}
	return ("success" in result && result.success === true) ||
		("status" in result &&
			(result.status === "completed" || result.status === "succeeded")) ||
		namesCreatedResource(result)
		? "COMPLETED"
		: "OUTCOME_UNKNOWN";
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (item && typeof item === "object" && !Array.isArray(item)) {
			return Object.fromEntries(
				Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
			);
		}
		return item;
	});
}

export function parlumeFingerprint(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parlumeToolFingerprint(input: {
	name: string;
	description?: string;
	inputSchema: unknown;
	source?: AgentToolSource;
}): string {
	const schema =
		input.inputSchema instanceof z.ZodType
			? z.toJSONSchema(input.inputSchema, { unrepresentable: "any" })
			: input.inputSchema;
	return parlumeFingerprint({
		name: input.source?.originalName ?? input.name,
		source: input.source
			? {
					configId: input.source.configId,
					originalName: input.source.originalName,
				}
			: undefined,
		description: input.description,
		schema,
	});
}

export function parlumeActionArguments(value: unknown) {
	const args = z.record(z.string(), z.json()).parse(value);
	const text = canonicalJson(args);
	if (text.length > 32_000) {
		throw new Error(
			"This action is too large to approve by voice. Review it in the agent chat.",
		);
	}
	function check(entry: JsonValue): void {
		if (Array.isArray(entry)) {
			for (const item of entry) {
				check(item);
			}
		} else if (entry && typeof entry === "object") {
			for (const [key, item] of Object.entries(entry)) {
				if (keyIsSensitive(key)) {
					throw new Error(
						"Actions containing credentials must be handled in the agent chat.",
					);
				}
				check(item);
			}
		} else if (
			typeof entry === "string" &&
			redactLogText(entry).redactionCount > 0
		) {
			throw new Error(
				"Actions containing credentials must be handled in the agent chat.",
			);
		}
	}
	check(args);
	return args;
}

export function summarizeParlumeAction(
	name: string,
	args: Record<string, JsonValue>,
): string {
	const action = name.replace(/^fabric_/, "").replace(/[_-]+/g, " ");
	const details = Object.entries(args)
		.map(
			([key, value]) =>
				`${key.replace(/[_-]+/g, " ")}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
		)
		.join("; ");
	const excerpt =
		details.length <= 430 ? details : `${details.slice(0, 430)}…`;
	return `${action.charAt(0).toUpperCase()}${action.slice(1)}${excerpt ? `. ${excerpt}` : ""}`;
}
