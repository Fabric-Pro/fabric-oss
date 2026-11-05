import { redactLogText } from "@repo/utils/log-redaction";

/** Provider error payloads must become bounded strings before execution logging. */
export function connectorErrorMessage(
	value: unknown,
	fallback: string,
): string {
	function message(input: unknown, depth: number): string | null {
		if (typeof input === "string" && input.trim()) {
			return input;
		}
		if (!input || typeof input !== "object" || depth === 0) {
			return null;
		}
		if (Array.isArray(input)) {
			for (const entry of input) {
				const result = message(entry, depth - 1);
				if (result) {
					return result;
				}
			}
			return null;
		}
		const record = input as Record<string, unknown>;
		for (const key of [
			"message",
			"description",
			"error",
			"errors",
			"detail",
			"msg",
			"title",
		]) {
			const result = message(record[key], depth - 1);
			if (result) {
				return result;
			}
		}
		return null;
	}
	return redactLogText(message(value, 4) ?? fallback).text.slice(0, 2000);
}
