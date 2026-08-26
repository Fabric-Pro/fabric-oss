import { db } from "@repo/database/prisma/client";
import type { Prisma } from "@repo/database/prisma/generated/client";

export interface PatternPlanState {
	messages: Array<{ content?: string | unknown }>;
	analysis?: string;
	checkboxes?: Prisma.InputJsonValue;
	projectContext: {
		projectId: string;
		projectName: string;
	};
	tenantContext: {
		userId: string;
		organizationId: string | null;
	};
	planId?: string;
}

export async function savePlanNode(state: PatternPlanState) {
	console.log("[Pattern] Saving plan to database...");

	const userMessage =
		state.messages[state.messages.length - 1]?.content || "";
	const planName = String(userMessage).slice(0, 100) || "Untitled Plan";

	if (state.planId) {
		const existingPlan = await db.weavePlan.findFirst({
			where: {
				id: state.planId,
				userId: state.tenantContext.userId,
				...(state.tenantContext.organizationId
					? { organizationId: state.tenantContext.organizationId }
					: { organizationId: null }),
			},
			select: { id: true },
		});

		if (!existingPlan) {
			throw new Error(`Canonical weave plan not found: ${state.planId}`);
		}

		const plan = await db.weavePlan.update({
			where: { id: state.planId },
			data: {
				name: planName,
				description: state.analysis?.slice(0, 500) || "",
				status: "DRAFT",
				checkboxes: state.checkboxes || [],
			},
		});

		return { planId: plan.id };
	}

	const plan = await db.weavePlan.create({
		data: {
			name: planName,
			description: state.analysis?.slice(0, 500) || "",
			status: "DRAFT",
			checkboxes: state.checkboxes || [],
			projectId: state.projectContext.projectId,
			userId: state.tenantContext.userId,
			organizationId: state.tenantContext.organizationId,
		},
	});

	return { planId: plan.id };
}
