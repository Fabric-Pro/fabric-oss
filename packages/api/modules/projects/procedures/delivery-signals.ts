import { tenantProtectedProcedure } from "../../../orpc/procedures";
import {
	deliverySignalGetInput,
	deliverySignalListInput,
	deliverySignalPage,
	deliverySignalProjectInput,
	deliverySignalRecord,
	deliverySignalSourceConfiguration,
} from "../lib/delivery-signal-contracts";
import { getDeliverySignalSourceConfiguration } from "../lib/delivery-signal-sources";
import {
	getDeliverySignal,
	listDeliverySignals,
	requireDeliverySignalProjectAccess,
} from "../lib/delivery-signals";

export const deliverySignalsProcedures = {
	list: tenantProtectedProcedure
		.route({
			method: "GET",
			path: "/projects/{projectId}/delivery/signals",
			tags: ["Projects"],
			summary: "Browse source-backed work already saved in a project",
		})
		.input(deliverySignalListInput)
		.output(deliverySignalPage)
		.handler(async ({ input, context }) => {
			const actor = { userId: context.user.id };
			await requireDeliverySignalProjectAccess(actor, input.projectId);
			return listDeliverySignals(actor, input);
		}),
	get: tenantProtectedProcedure
		.route({
			method: "GET",
			path: "/projects/{projectId}/delivery/signals/{id}",
			tags: ["Projects"],
			summary: "Read a minimized saved-work entry",
		})
		.input(deliverySignalGetInput)
		.output(deliverySignalRecord)
		.handler(async ({ input, context }) => {
			const actor = { userId: context.user.id };
			await requireDeliverySignalProjectAccess(actor, input.projectId);
			return getDeliverySignal(actor, input);
		}),
	sourceConfiguration: tenantProtectedProcedure
		.route({
			method: "GET",
			path: "/projects/{projectId}/delivery/sources",
			tags: ["Projects"],
			summary:
				"Inspect your own saved source setup without checking live capture",
		})
		.input(deliverySignalProjectInput)
		.output(deliverySignalSourceConfiguration)
		.handler(async ({ input, context }) => {
			const actor = { userId: context.user.id };
			await requireDeliverySignalProjectAccess(actor, input.projectId);
			return getDeliverySignalSourceConfiguration(actor, input);
		}),
};
