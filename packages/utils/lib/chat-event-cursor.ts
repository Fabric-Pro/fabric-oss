import { z } from "zod";

/** A cursor identifies one output log, never permission to observe it. */
export const chatEventCursorSchema = z.strictObject({
	turnId: z.string().min(1).max(200),
	runId: z.string().min(1).max(200),
	sequence: z
		.string()
		.regex(/^[1-9][0-9]{0,18}$/)
		.refine((value) => value.length < 19 || value <= "9223372036854775807"),
});
export type ChatEventCursor = z.infer<typeof chatEventCursorSchema>;

export function sameChatEventLog(a: ChatEventCursor, b: ChatEventCursor) {
	return a.turnId === b.turnId && a.runId === b.runId;
}
