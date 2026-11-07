import { ORPCError } from "@orpc/server";
import {
	applyFrameChange,
	approveFrameRevision,
	dismissFrameChange,
	FrameReviewError,
	getFrameChange,
	getFrameReviewState,
	listFrameChanges,
	proposeFrameChange,
} from "@repo/database";
import {
	frameApplyChangeSchema,
	frameApproveRevisionSchema,
	frameChangeIdentitySchema,
	frameProposalListSchema,
	frameProposeChangeSchema,
} from "@repo/utils/frame-review-contracts";
import { z } from "zod";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const identity = {
	id: z.string().min(1).max(200),
	organizationId: z.string().optional(),
};
const operations = {
	propose: proposeFrameChange,
	list: listFrameChanges,
	get: getFrameChange,
	apply: applyFrameChange,
	dismiss: dismissFrameChange,
	approve: approveFrameRevision,
	state: getFrameReviewState,
};
const errors = tenantProtectedProcedure.use(async ({ next }) => {
	try {
		return await next();
	} catch (e) {
		if (e instanceof FrameReviewError) {
			throw new ORPCError(e.code, { message: e.message });
		}
		throw e;
	}
});
function actor(
	context: {
		user: { id: string };
		session: Parameters<typeof resolveOrganizationId>[1];
	},
	organizationId?: string,
) {
	return {
		userId: context.user.id,
		organizationId: resolveOrganizationId(organizationId, context.session)!,
	};
}
export const proposeFrameChangeProcedure = errors
	.route({
		method: "POST",
		path: "/frames/{id}/changes",
		tags: ["Frames"],
		summary: "Propose a page change",
	})
	.input(frameProposeChangeSchema.extend(identity))
	.handler(({ input, context }) => {
		const { id, organizationId, ...body } = input;
		return operations.propose(actor(context, organizationId), id, body);
	});
export const listFrameChangesProcedure = errors
	.route({
		method: "GET",
		path: "/frames/{id}/changes",
		tags: ["Frames"],
		summary: "List page change reviews",
	})
	.input(frameProposalListSchema.extend(identity))
	.handler(({ input, context }) => {
		const { id, organizationId, ...body } = input;
		return operations.list(actor(context, organizationId), id, body);
	});
export const getFrameChangeProcedure = errors
	.route({
		method: "GET",
		path: "/frames/{id}/changes/{proposalId}",
		tags: ["Frames"],
		summary: "Read a proposed change",
	})
	.input(frameChangeIdentitySchema.extend(identity))
	.handler(({ input, context }) => {
		const { id, organizationId, ...body } = input;
		return operations.get(actor(context, organizationId), id, body);
	});
export const applyFrameChangeProcedure = errors
	.route({
		method: "POST",
		path: "/frames/{id}/changes/{proposalId}/apply",
		tags: ["Frames"],
		summary: "Apply the reviewed page change",
	})
	.input(frameApplyChangeSchema.extend(identity))
	.handler(({ input, context }) => {
		const { id, organizationId, ...body } = input;
		return operations.apply(actor(context, organizationId), id, body);
	});
export const dismissFrameChangeProcedure = errors
	.route({
		method: "POST",
		path: "/frames/{id}/changes/{proposalId}/dismiss",
		tags: ["Frames"],
		summary: "Dismiss a proposed page change",
	})
	.input(frameChangeIdentitySchema.extend(identity))
	.handler(({ input, context }) => {
		const { id, organizationId, ...body } = input;
		return operations.dismiss(actor(context, organizationId), id, body);
	});
export const getFrameReviewProcedure = errors
	.route({
		method: "GET",
		path: "/frames/{id}/review",
		tags: ["Frames"],
		summary: "Read page review status",
	})
	.input(z.strictObject(identity))
	.handler(({ input, context }) =>
		operations.state(actor(context, input.organizationId), input.id),
	);
export const approveFrameRevisionProcedure = errors
	.route({
		method: "POST",
		path: "/frames/{id}/approve",
		tags: ["Frames"],
		summary: "Approve the current private revision",
	})
	.input(frameApproveRevisionSchema.extend(identity))
	.handler(({ input, context }) => {
		const { id, organizationId, ...body } = input;
		return operations.approve(actor(context, organizationId), id, body);
	});
