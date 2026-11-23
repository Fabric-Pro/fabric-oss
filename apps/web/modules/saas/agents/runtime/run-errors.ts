import { EventType } from "@ag-ui/client";
import { z } from "zod";
import { aiUsageLimitPausedMessage } from "../../../../app/api/agents/fabric-ai/stream/ai-usage-limit-paused-message";
import type { RunStream } from "./engine";

const refusalBodySchema = z
	.object({
		error: z.string().optional(),
		message: z.string().optional(),
		code: z.string().optional(),
	})
	.passthrough();

const limitWindowSchema = z.object({
	data: z.object({
		window: z.enum(["HOURLY", "DAILY", "WEEKLY", "MONTHLY"]),
	}),
});

/**
 * What a turn refused at admission saves as its answer, so a reopened chat
 * shows why it ended: a usage limit as the paused state (never the limit's
 * id), else the refusal's own words. Reads a copy, so the refusal can still
 * be sent.
 */
export async function refusalRecordText(refusal: Response): Promise<string> {
	const raw: unknown = await refusal
		.clone()
		.json()
		.catch(() => null);
	const limit = limitWindowSchema.safeParse(raw);
	if (limit.success) {
		return aiUsageLimitPausedMessage(limit.data.data.window);
	}
	const body = refusalBodySchema.safeParse(raw);
	return (
		(body.success ? (body.data.message ?? body.data.error) : undefined) ??
		`The request was refused (${refusal.status}).`
	);
}

/** End the run with an error the client can branch on by `code`. */
export function refuse(stream: RunStream, code: string, message: string): void {
	stream.emit({ type: EventType.RUN_ERROR, message, code });
}

/**
 * A refusal from a stream route's admission (its JSON error Response), as
 * the run's error: the body's code (`HTTP_<status>` when it names none), its
 * message, and the whole body as `metadata.fabric`.
 */
export async function refuseWithResponse(
	stream: RunStream,
	refusal: Response,
): Promise<void> {
	const body = refusalBodySchema.safeParse(
		await refusal.json().catch(() => null),
	);
	const details = body.success ? body.data : {};
	stream.emit({
		type: EventType.RUN_ERROR,
		message:
			details.message ??
			details.error ??
			`Turn refused (${refusal.status})`,
		code: details.code ?? `HTTP_${refusal.status}`,
		metadata: { fabric: { status: refusal.status, ...details } },
	});
}
