import { validateFrameCode } from "@repo/code-validation";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	code: z.string(),
});

const outputSchema = z.object({
	valid: z.boolean(),
	canSave: z.boolean(),
	syntax: z.object({
		valid: z.boolean(),
		errors: z.array(
			z.object({
				message: z.string(),
				line: z.number(),
				column: z.number(),
				severity: z.enum(["error", "warning"]),
			}),
		),
	}),
	tailwind: z.object({
		valid: z.boolean(),
		warnings: z.array(
			z.object({
				message: z.string(),
				className: z.string(),
				line: z.number().optional(),
				column: z.number().optional(),
			}),
		),
	}),
	issues: z.array(
		z.object({
			type: z.enum(["syntax", "tailwind"]),
			severity: z.enum(["error", "warning", "info"]),
			message: z.string(),
			line: z.number().optional(),
			column: z.number().optional(),
			details: z.string().optional(),
		}),
	),
});

/**
 * Validate frame code
 *
 * Performs TypeScript/JSX syntax validation and Tailwind CSS class validation.
 * Returns detailed error/warning information.
 */
export const validateFrameCodeProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "POST",
		path: "/frames/validate",
		tags: ["Frames"],
		summary: "Validate frame code",
		description: "Validate TypeScript/JSX syntax and Tailwind CSS classes",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input }) => {
		const result = validateFrameCode(input.code);

		return {
			valid: result.valid,
			canSave: result.canSave,
			syntax: result.syntax,
			tailwind: result.tailwind,
			issues: result.allIssues,
		};
	});
