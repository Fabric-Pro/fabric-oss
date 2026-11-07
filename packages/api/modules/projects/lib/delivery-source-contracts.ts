import { isDeliverySourceCaptureWindow } from "@repo/connectors/delivery-source-capture-limits";
import { z } from "zod";

const id = z.string().trim().min(1).max(200);
export const deliverySourceProjectInput = z.strictObject({ projectId: id });
export const deliverySourceWatchInput = deliverySourceProjectInput.extend({
	watchId: id,
});
export const deliverySourceCancelInput = deliverySourceWatchInput.extend({
	requestId: z.uuid(),
});
export const deliverySourceInspectInput = deliverySourceProjectInput.extend({
	integrationId: id,
	channelId: id,
});
export const deliverySourceConfigureInput = deliverySourceInspectInput.extend({
	requestId: z.uuid(),
	retentionDays: z.union([z.literal(7), z.literal(30)]).default(7),
});
export const deliverySourceStateInput = deliverySourceWatchInput.extend({
	requestId: z.uuid(),
	expectedVersion: z.number().int().positive(),
	action: z.enum(["PAUSE", "RESUME", "DISCONNECT"]),
});
export const deliverySourceCaptureWindow = z
	.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() })
	.refine(
		isDeliverySourceCaptureWindow,
		"Choose a window of up to seven days.",
	).transform(window=>({start:new Date(window.start).toISOString(),end:new Date(window.end).toISOString()}));
export const deliverySourceCaptureInput = deliverySourceWatchInput
	.extend({
		requestId: z.uuid(),
		expectedVersion: z.number().int().positive(),
		mode: z.enum(["RECENT", "CONTINUE", "BACKFILL"]).default("RECENT"),
		window: deliverySourceCaptureWindow.optional(),
	})
	.refine(
		(input) => (input.mode === "BACKFILL") === (input.window !== undefined),
		"A selected window is required only for BACKFILL.",
	);
export const deliverySourceObservationInput = deliverySourceWatchInput.extend({
	limit: z.number().int().min(1).max(50).default(20),
	cursor: z.unknown().optional(),
});
export const deliverySourceEvidenceInput = deliverySourceWatchInput.extend({
	observationId: id,
});

export const deliverySourceWatch = z.strictObject({
	id,
	provider: z.literal("SLACK"),
	label: z.string().max(200),
	state: z.enum(["ACTIVE", "PAUSED", "DISCONNECTED"]),
	version: z.number().int().positive(),
	visibility: z.literal("ONLY_ME"),
	retentionDays: z.union([z.literal(7), z.literal(30)]),
	verifiedAt: z.iso.datetime(),
	createdAt: z.iso.datetime(),
	lastRequestId: z.string().nullable(),
	hasMore: z.boolean(),
	captureWindow: z
		.strictObject({
			start: z.iso.datetime(),
			end: z.iso.datetime(),
			complete: z.boolean(),
		})
		.nullable(),
	lastCaptureInput: z
		.strictObject({
			requestId: z.uuid(),
			expectedVersion: z.number().int().positive(),
			mode: z.enum(["RECENT", "CONTINUE", "BACKFILL"]),
			window: deliverySourceCaptureWindow.optional(),
		})
		.nullable(),
});
export const deliverySourceAvailability = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("ENABLED"), reason: z.null() }),
	z.strictObject({
		state: z.literal("UNAVAILABLE"),
		reason: z.enum(["NOT_ENABLED", "STORAGE_UNAVAILABLE"]),
	}),
]);
/** Operator/storage availability only; never a provider-health or source-access grant. */
export const deliverySourceList = z.strictObject({
	version: z.literal(1),
	availability: deliverySourceAvailability,
	watches: z.array(deliverySourceWatch).max(50),
	connections: z
		.array(
			z.strictObject({
				id,
				name: z.string().max(200),
				supportsPrivateCapture: z.boolean(),
			}),
		)
		.max(50),
});
export const deliverySourceInspection = z.strictObject({
	version: z.literal(1),
	provider: z.literal("SLACK"),
	label: z.string().max(200),
	visibility: z.literal("ONLY_ME"),
	checkedAt: z.iso.datetime(),
	coverage: z.literal("ROOT_MESSAGES_ONLY"),
});
export const deliverySourceRun = z.strictObject({
	/** Native fencing readiness only; starting again independently checks current write/source access. */
	canStartNewCapture: z.boolean().optional(),
	version: z.literal(1),
	state: z.enum([
		"NOT_STARTED",
		"RUNNING",
		"COMPLETED",
		"FAILED",
		"CANCELLED",
		"OUTCOME_UNKNOWN",
	]),
	requestId: z.string().nullable(),
	coverage: z.enum(["ROOT_MESSAGES_ONLY", "PARTIAL"]).nullable(),
	captured: z.number().int().nonnegative().nullable(),
	hasMore: z.boolean(),
	message: z.string().max(240).nullable(),
});
export const deliverySourceObservation = z.strictObject({
	id,
	capturedAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	change: z.enum(["UPSERT", "DELETE"]),
	hasConflict: z.boolean(),
	coverage: z.literal("ROOT_MESSAGES_ONLY"),
});
export const deliverySourceObservationPage = z.strictObject({
	version: z.literal(1),
	items: z.array(deliverySourceObservation).max(50),
	nextCursor: z.string().nullable(),
});
export const deliverySourceEvidence = z.strictObject({
	version: z.literal(1),
	observationId: id,
	text: z.string().max(16384),
	capturedAt: z.iso.datetime(),
	checkedAt: z.iso.datetime(),
	coverage: z.literal("ROOT_MESSAGES_ONLY"),
	visibility: z.literal("ONLY_ME"),
});

export type DeliverySourceOperation =
	| "list"
	| "inspect"
	| "configure"
	| "pause"
	| "resume"
	| "disconnect"
	| "capture"
	| "status"
	| "cancel"
	| "observations"
	| "evidence";
/** Credential ceilings only; every command independently repeats current actor/object checks. */
export function deliverySourceRequiredScopes(
	operation: DeliverySourceOperation,
): string[] {
	const write = [
		"configure",
		"pause",
		"resume",
		"disconnect",
		"capture",
		"cancel",
	].includes(operation);
	const network = [
		"inspect",
		"configure",
		"resume",
		"capture",
		"evidence",
	].includes(operation);
	return [
		write ? "projects:write" : "projects:read",
		write ? "features:write" : "features:read",
		"integrations:read",
		...(network ? ["integrations:execute"] : []),
	];
}
