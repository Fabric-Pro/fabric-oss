import { ORPCError } from "@orpc/server";
import {
	compareSchema,
	configureSchema,
	identitySchema,
	listSchema,
	RunQualityError,
	runQualityTargetSchema,
} from "@repo/utils/run-quality-contracts";
import { z } from "zod";
import { tenantProtectedProcedure } from "../../orpc/procedures";
import { resolvedOrganizationId } from "../agents/procedures/conversations/resolved-organization";
import * as commands from "./lib/commands";

const org = { organizationId: z.string().min(1).max(200).optional() };
async function translate<T>(run: () => Promise<T>) {
	try {
		return await run();
	} catch (error) {
		if (error instanceof RunQualityError) {
			throw new ORPCError(
				error.code === "UNAVAILABLE"
					? "SERVICE_UNAVAILABLE"
					: error.code,
				{ message: error.message },
			);
		}
		throw error;
	}
}
const actor = (
	input: { organizationId?: string },
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string | null };
	},
) => ({
	userId: context.user.id,
	organizationId: resolvedOrganizationId(input, context.session),
});
export const runQualityRouter = {
	policy: {
		get: tenantProtectedProcedure
			.input(runQualityTargetSchema.extend(org))
			.handler(({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					commands.getRunQualityPolicy(
						actor(input, context),
						request,
					),
				);
			}),
		configure: tenantProtectedProcedure
			.input(configureSchema.safeExtend(org))
			.handler(({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					commands.configureRunQualityPolicy(
						actor(input, context),
						request,
					),
				);
			}),
	},
	assessments: {
		list: tenantProtectedProcedure
			.input(listSchema.extend(org))
			.handler(({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					commands.listRunQualityAssessments(
						actor(input, context),
						request,
					),
				);
			}),
		get: tenantProtectedProcedure
			.input(identitySchema.extend(org))
			.handler(({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					commands.getRunQualityAssessment(
						actor(input, context),
						request,
					),
				);
			}),
		cancel: tenantProtectedProcedure
			.input(identitySchema.extend(org))
			.handler(({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					commands.cancelRunQualityAssessment(
						actor(input, context),
						request,
					),
				);
			}),
		compare: tenantProtectedProcedure
			.input(compareSchema.safeExtend(org))
			.handler(({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					commands.compareRunQualityAssessments(
						actor(input, context),
						request,
					),
				);
			}),
	},
};
