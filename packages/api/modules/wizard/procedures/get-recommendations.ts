import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	getFeatureRecommendations,
	getTechStackRecommendations,
} from "../lib/auto-selection-mappings";

export const getRecommendationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/wizard/recommendations",
		tags: ["Wizard", "Recommendations"],
		summary: "Get auto-selection recommendations",
		description:
			"Get recommended tech stack and features based on selected project types",
	})
	.input(
		z.object({
			projectTypes: z.array(z.string()),
			description: z.string().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const { projectTypes } = input;

		// Get recommendations based on project types
		const techStackRecommendations =
			getTechStackRecommendations(projectTypes);
		const featureRecommendations = getFeatureRecommendations(projectTypes);

		return {
			techStack: techStackRecommendations,
			features: featureRecommendations,
		};
	});
