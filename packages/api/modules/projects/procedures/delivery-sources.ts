import { tenantProtectedProcedure } from "../../../orpc/procedures";
import * as commands from "../lib/delivery-source-commands";
import {
	deliverySourceCancelInput,
	deliverySourceCaptureInput,
	deliverySourceConfigureInput,
	deliverySourceEvidence,
	deliverySourceEvidenceInput,
	deliverySourceInspectInput,
	deliverySourceInspection,
	deliverySourceList,
	deliverySourceObservationInput,
	deliverySourceObservationPage,
	deliverySourceProjectInput,
	deliverySourceRun,
	deliverySourceStateInput,
	deliverySourceWatch,
	deliverySourceWatchInput,
} from "../lib/delivery-source-contracts";

// These responses contain current private-source state or freshly authorized
// evidence. Carry the policy through ResponseHeadersPlugin to HTTP responses.
const privateSourceProcedure = tenantProtectedProcedure.use(
	async ({ context, next }) => {
		context.resHeaders?.set("Cache-Control", "private, no-store");
		return next();
	},
);

/** Session actors never inherit a credential organization binding from their chrome. */
export const deliverySourcesProcedures = {
	list: privateSourceProcedure
		.route({
			method: "GET",
			path: "/projects/{projectId}/delivery/private-sources",
			tags: ["Projects"],
			summary: "List your private source watches",
		})
		.input(deliverySourceProjectInput)
		.output(deliverySourceList)
		.handler(({ input, context }) =>
			commands.listDeliverySourceWatches(
				{ userId: context.user.id },
				input,
			),
		),
	inspect: privateSourceProcedure
		.route({
			method: "POST",
			path: "/projects/{projectId}/delivery/private-sources/inspect",
			tags: ["Projects"],
			summary: "Inspect your private source access",
		})
		.input(deliverySourceInspectInput)
		.output(deliverySourceInspection)
		.handler(({ input, context }) =>
			commands.inspectDeliverySource({ userId: context.user.id }, input),
		),
	configure: privateSourceProcedure
		.route({
			method: "POST",
			path: "/projects/{projectId}/delivery/private-sources",
			tags: ["Projects"],
			summary: "Connect a private source watch",
		})
		.input(deliverySourceConfigureInput)
		.output(deliverySourceWatch)
		.handler(({ input, context }) =>
			commands.configureDeliverySource(
				{ userId: context.user.id },
				input,
			),
		),
	state: privateSourceProcedure
		.route({
			method: "POST",
			path: "/projects/{projectId}/delivery/private-sources/{watchId}/state",
			tags: ["Projects"],
			summary: "Pause, resume or disconnect your source watch",
		})
		.input(deliverySourceStateInput)
		.output(deliverySourceWatch)
		.handler(({ input, context }) =>
			commands.updateDeliverySourceState(
				{ userId: context.user.id },
				input,
			),
		),
	capture: privateSourceProcedure
		.route({
			method: "POST",
			path: "/projects/{projectId}/delivery/private-sources/{watchId}/capture",
			tags: ["Projects"],
			summary: "Start bounded private source capture",
		})
		.input(deliverySourceCaptureInput)
		.output(deliverySourceRun)
		.handler(({ input, context }) =>
			commands.startDeliverySourceCapture(
				{ userId: context.user.id },
				input,
			),
		),
	status: privateSourceProcedure
		.route({
			method: "GET",
			path: "/projects/{projectId}/delivery/private-sources/{watchId}/capture",
			tags: ["Projects"],
			summary: "Read private capture status",
		})
		.input(deliverySourceWatchInput)
		.output(deliverySourceRun)
		.handler(({ input, context }) =>
			commands.getDeliverySourceCaptureStatus(
				{ userId: context.user.id },
				input,
			),
		),
	cancel: privateSourceProcedure
		.route({
			method: "POST",
			path: "/projects/{projectId}/delivery/private-sources/{watchId}/capture/cancel",
			tags: ["Projects"],
			summary: "Cancel private capture",
		})
		.input(deliverySourceCancelInput)
		.output(deliverySourceRun)
		.handler(({ input, context }) =>
			commands.cancelDeliverySourceCapture(
				{ userId: context.user.id },
				input,
			),
		),
	observations: privateSourceProcedure
		.route({
			method: "GET",
			path: "/projects/{projectId}/delivery/private-sources/{watchId}/observations",
			tags: ["Projects"],
			summary: "List private observation receipts",
		})
		.input(deliverySourceObservationInput)
		.output(deliverySourceObservationPage)
		.handler(({ input, context }) =>
			commands.listDeliverySourceObservations(
				{ userId: context.user.id },
				input,
			),
		),
	evidence: privateSourceProcedure
		.route({
			method: "GET",
			path: "/projects/{projectId}/delivery/private-sources/{watchId}/observations/{observationId}",
			tags: ["Projects"],
			summary: "Read fresh-authorized private evidence",
		})
		.input(deliverySourceEvidenceInput)
		.output(deliverySourceEvidence)
		.handler(({ input, context }) =>
			commands.getDeliverySourceEvidence(
				{ userId: context.user.id },
				input,
			),
		),
};
