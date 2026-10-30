import { EventType } from "@ag-ui/client";
import { z } from "zod";
import type { RunStream } from "./engine";

const refusalBodySchema = z
	.object({
		error: z.string().optional(),
		message: z.string().optional(),
		code: z.string().optional(),
	})
	.passthrough();

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
