import { createHash } from "node:crypto";

interface ModelOutputOptions {
	toolCallId: string;
	input: unknown;
	output: unknown;
}

interface ExecutableTool {
	execute: (...args: unknown[]) => unknown;
	toModelOutput?: (options: ModelOutputOptions) => unknown;
}

function isExecutable(value: unknown): value is ExecutableTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"execute" in value &&
		typeof value.execute === "function"
	);
}

function isStreaming(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		Symbol.asyncIterator in value
	);
}

function isPromise(value: unknown): value is Promise<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

function canonicalJson(value: unknown): string | undefined {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			return;
		}
		// Normalize to JSON before sorting so toJSON and omitted values have
		// the same meaning as in the SDK's model-output conversion.
		return JSON.stringify(JSON.parse(serialized), (_key, item) =>
			item && typeof item === "object" && !Array.isArray(item)
				? Object.fromEntries(
						Object.keys(item)
							.sort()
							.map((key) => [key, item[key]]),
					)
				: item,
		);
	} catch {
		return undefined;
	}
}

function defaultModelOutput(output: unknown) {
	if (typeof output === "string") {
		return { type: "text", value: output };
	}
	// Match AI SDK's toJSONValue, including undefined -> null.
	const serialized = JSON.stringify(output);
	return {
		type: "json",
		value: serialized === undefined ? null : JSON.parse(serialized),
	};
}

/**
 * Wraps executable tools in place for one turn. Repeated results become a
 * short model-facing notice; execute still returns the real output for the UI
 * and turn record. Streaming and non-serializable results are not counted.
 */
export function guardToolsAgainstRepeatedCalls(
	tools: Record<string, unknown>,
	{ onRepeat }: { onRepeat?: (toolName: string, count: number) => void } = {},
): void {
	const seen = new Set<string>();
	for (const [name, definition] of Object.entries(tools)) {
		if (!isExecutable(definition)) {
			continue;
		}
		const execute = definition.execute;
		const repeats = new Set<string>();
		let repeatCount = 0;
		tools[name] = {
			...definition,
			execute: (
				input: unknown,
				options?: unknown,
				...rest: unknown[]
			) => {
				const result = execute(input, options, ...rest);
				if (isStreaming(result) || !isPromise(result)) {
					return result;
				}
				return result.then((output) => {
					if (isStreaming(output)) {
						return output;
					}
					const toolCallId =
						typeof options === "object" &&
						options !== null &&
						"toolCallId" in options
							? options.toolCallId
							: undefined;
					const canonicalInput = canonicalJson(input);
					const canonicalOutput = canonicalJson(output);
					if (
						typeof toolCallId === "string" &&
						canonicalInput !== undefined &&
						canonicalOutput !== undefined
					) {
						// A digest, so a turn of large reads does not keep
						// every output in memory until it ends.
						const key = createHash("sha256")
							.update(
								JSON.stringify([
									name,
									canonicalInput,
									canonicalOutput,
								]),
							)
							.digest("hex");
						if (seen.has(key)) {
							repeats.add(toolCallId);
							onRepeat?.(name, ++repeatCount);
						}
						seen.add(key);
					}
					return output;
				});
			},
			toModelOutput: (options: ModelOutputOptions) => {
				if (repeats.has(options.toolCallId)) {
					return {
						type: "text",
						value: `This is the same result the earlier ${name} call with these arguments returned. Answer from that earlier result or try different arguments rather than calling it again with the same arguments.`,
					};
				}
				return definition.toModelOutput
					? definition.toModelOutput(options)
					: defaultModelOutput(options.output);
			},
		};
	}
}
