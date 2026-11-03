import { z } from "zod";

const MAX_RECEIPTS = 100;
const MAX_RECORDS = 10_000;
const scopeSchema = z.object({
	sessionId: z.string().min(1).max(128),
	projectId: z.string().min(1).max(128),
	organizationId: z.string().min(1).max(128),
});
const evidenceSchema = scopeSchema
	.extend({
		version: z.literal(1),
		receipts: z
			.array(
				z
					.object({
						tag: z
							.string()
							.max(7)
							.regex(/^P\d{1,6}$/),
						confirmedAt: z
							.string()
							.max(40)
							.pipe(z.iso.datetime())
							.nullable(),
					})
					.strict(),
			)
			.max(MAX_RECEIPTS),
		omittedCount: z.number().int().min(0).max(MAX_RECORDS),
	})
	.strict()
	.refine(
		(evidence) =>
			evidence.receipts.length + evidence.omittedCount <= MAX_RECORDS &&
			(evidence.omittedCount === 0 ||
				evidence.receipts.length === MAX_RECEIPTS) &&
			new Set(evidence.receipts.map((receipt) => receipt.tag)).size ===
				evidence.receipts.length,
	);
type Evidence = z.infer<typeof evidenceSchema>;
type Scope = z.infer<typeof scopeSchema>;

export function buildParlumeChatDeliveryEvidence(
	scope: Scope,
	receipts: ReadonlyArray<{ tag: string; confirmedAt: Date | null }>,
): Evidence {
	return evidenceSchema.parse({
		...scope,
		version: 1,
		receipts: receipts.slice(-MAX_RECEIPTS).map((receipt) => ({
			tag: receipt.tag,
			confirmedAt: receipt.confirmedAt?.toISOString() ?? null,
		})),
		omittedCount: Math.max(0, receipts.length - MAX_RECEIPTS),
	});
}

export function readParlumeChatDeliveryEvidence(
	metadata: unknown,
	scope: Scope,
): Evidence | null {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		Array.isArray(metadata) ||
		!("parlumeChannelChatDelivery" in metadata)
	) {
		return null;
	}
	const value = metadata.parlumeChannelChatDelivery;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("receipts" in value) ||
		!Array.isArray(value.receipts) ||
		value.receipts.length > MAX_RECEIPTS
	) {
		return null;
	}
	const parsed = evidenceSchema.safeParse(value);
	return parsed.success &&
		parsed.data.sessionId === scope.sessionId &&
		parsed.data.projectId === scope.projectId &&
		parsed.data.organizationId === scope.organizationId
		? parsed.data
		: null;
}

export function formatParlumeChatDeliveryEvidence(
	evidence: Evidence | null,
): string {
	const lines = [
		"Session-level channel-thread delivery facts (separate from generated responses and Fabric mutation receipts):",
		"These facts concern only the listed post tags. They do not confirm a particular request, a Fabric mutation, audio playback, or that a post remains present and unedited now.",
	];
	if (!evidence) {
		lines.push(
			"No valid delivery metadata is recorded. This does not prove delivery or failure.",
		);
	} else if (evidence.receipts.length === 0) {
		lines.push(
			"No channel-thread delivery receipts recorded. Ordinary meeting chat is outside these receipts.",
		);
	} else {
		for (const receipt of evidence.receipts) {
			lines.push(
				receipt.confirmedAt
					? `${receipt.tag}: exact Graph reply and content observed at ${receipt.confirmedAt}.`
					: `${receipt.tag}: delivery not verified; this does not prove failure.`,
			);
		}
		if (evidence.omittedCount > 0) {
			lines.push(
				`Earlier receipts omitted: ${evidence.omittedCount}. Do not infer their delivery status.`,
			);
		}
	}
	return lines.join("\n");
}
