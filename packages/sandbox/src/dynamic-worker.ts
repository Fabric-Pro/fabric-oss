import { z } from "zod";

export const DYNAMIC_CODE_LIMITS = {
	sourceBytes: 32 * 1024,
	inputBytes: 64 * 1024,
	outputBytes: 64 * 1024,
	logBytes: 16 * 1024,
	logEntries: 100,
	logEntryBytes: 4096,
	responseBytes: 256 * 1024,
	requestBytes: 256 * 1024,
	cpuMs: 1000,
} as const;

/** The subset of Cloudflare's WorkerLoader used by stateless scripts. */
export interface DynamicCodeLoader {
	load(config: {
		compatibilityDate: string;
		mainModule: string;
		modules: Record<string, string>;
		env: Record<string, never>;
		globalOutbound: null;
		limits: { cpuMs: number; subRequests: number };
	}): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
}

export function jsonByteLength(value: unknown): number {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new Error("A JSON value is required");
	}
	return new TextEncoder().encode(serialized).byteLength;
}

const SourceSchema = z
	.string()
	.trim()
	.min(1)
	.refine(
		(code) =>
			new TextEncoder().encode(code).byteLength <=
			DYNAMIC_CODE_LIMITS.sourceBytes,
		"Script source exceeds 32 KiB",
	);

const InputsSchema = z
	.record(z.string(), z.json())
	.refine(
		(inputs) => jsonByteLength(inputs) <= DYNAMIC_CODE_LIMITS.inputBytes,
		"Script inputs exceed 64 KiB",
	);

export const ScriptExecutionContextSchema = z.strictObject({
	executionId: z.string().min(1).max(128),
	workflowId: z.string().min(1).max(128),
	version: z.number().int().positive(),
	triggerType: z.enum(["MANUAL", "WEBHOOK", "SCHEDULE", "EVENT"]),
});

export const ExecuteCodeRequestSchema = z.strictObject({
	code: SourceSchema,
	language: z.enum(["javascript", "typescript"]),
	inputs: InputsSchema.default({}),
	timeout: z.number().int().min(1000).max(60000).default(30000),
	execution: ScriptExecutionContextSchema.optional(),
});
export type ExecuteCodeRequest = z.infer<typeof ExecuteCodeRequestSchema>;
export const ExecuteCodePublicRequestSchema = ExecuteCodeRequestSchema.omit({
	execution: true,
});

export const ExecuteCodeResponseSchema = z.object({
	code: SourceSchema,
	logs: z
		.array(
			z.object({
				type: z.enum(["stdout", "stderr"]),
				text: z
					.string()
					.refine(
						(text) =>
							new TextEncoder().encode(text).byteLength <=
							DYNAMIC_CODE_LIMITS.logEntryBytes,
					),
			}),
		)
		.max(DYNAMIC_CODE_LIMITS.logEntries)
		.refine(
			(logs) =>
				logs.reduce(
					(bytes, log) =>
						bytes + new TextEncoder().encode(log.text).byteLength,
					0,
				) <= DYNAMIC_CODE_LIMITS.logBytes,
		),
	results: z
		.array(
			z.union([
				z.object({ type: z.literal("text"), text: z.string() }),
				z.object({ type: z.literal("json"), json: z.json() }),
			]),
		)
		.max(1)
		.refine(
			(results) =>
				jsonByteLength(results) <= DYNAMIC_CODE_LIMITS.outputBytes,
		)
		.optional(),
	error: z.string().max(4096).optional(),
	executionCount: z.literal(1),
	executionTime: z.number().finite().nonnegative(),
});
export type ExecuteCodeResponse = z.infer<typeof ExecuteCodeResponseSchema>;

export async function readBoundedJson(
	message: Request | Response,
	maxBytes: number,
): Promise<unknown> {
	const declared = Number(message.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error("Sandbox message exceeds its size limit");
	}
	const reader = message.body?.getReader();
	if (!reader) {
		throw new Error("Sandbox message has no body");
	}
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) {
				throw new Error("Sandbox message exceeds its size limit");
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return JSON.parse(text);
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}
