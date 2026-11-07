import { z } from "zod";

export const deliverySignalProvider = z.enum([
	"SLACK",
	"TEAMS",
	"JIRA",
	"AZURE_DEVOPS",
	"FIZZY",
]);
export type DeliverySignalProvider = z.infer<typeof deliverySignalProvider>;
const identifier = z.string().trim().min(1).max(200);
export const deliverySignalProjectInput = z.strictObject({
	projectId: identifier,
});
export const deliverySignalListInput = deliverySignalProjectInput.extend({
	source: deliverySignalProvider.optional(),
	search: z.string().trim().max(120).default(""),
	limit: z.number().int().min(1).max(50).default(20),
	// Cursor validation deliberately follows live project authorization.
	cursor: z.unknown().optional(),
});
export const deliverySignalGetInput = deliverySignalProjectInput.extend({
	id: identifier,
});
export const deliverySignalRecord = z.strictObject({
	id: z.string(),
	identifier: z.string(),
	title: z.string().refine((value) => Array.from(value).length <= 240),
	source: deliverySignalProvider,
	kind: z.literal("PROJECT_WORK_ITEM"),
	draftingStage: z.enum([
		"PLACEHOLDER",
		"PASSIVE_ANALYSIS",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"CLOSED",
	]),
	createdAt: z.iso.datetime(),
	href: z.string().startsWith("/app/"),
});
export const deliverySignalPage = z.strictObject({
	version: z.literal(1),
	coverage: z.literal("PROJECT_WORK_ITEMS_ONLY"),
	items: z.array(deliverySignalRecord).max(50),
	nextCursor: z.string().nullable(),
});
export const deliverySignalSourceConfiguration = z.strictObject({
	version: z.literal(1),
	items: z
		.array(
			z.strictObject({
				source: deliverySignalProvider,
				state: z.enum([
					"NOT_CONFIGURED",
					"CONFIGURED_NOT_CHECKED",
					"PAUSED",
				]),
			}),
		)
		.length(5),
});
