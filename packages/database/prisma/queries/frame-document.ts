import { artifactBrandSnapshotSchema } from "@repo/utils/artifact-brand-snapshot";
import { FRAME_PRESENTATIONS } from "@repo/utils/frame-presentation";
import { z } from "zod";

export const FrameBlockSchema = z.object({
	id: z.string(),
	type: z.enum(["html", "json", "mermaid", "markdown"]),
	title: z.string().optional(),
	content: z.string(),
	language: z.string().optional(),
});

export const FrameDocumentSchema = z.object({
	version: z.literal(1),
	kind: z.enum(["frame", "slideshow"]),
	presentation: z.enum(FRAME_PRESENTATIONS).optional(),
	title: z.string(),
	description: z.string().optional(),
	blocks: z.array(FrameBlockSchema).min(1),
	theme: z
		.object({
			mode: z.enum(["light", "dark", "system"]).optional(),
			accentColor: z.string().optional(),
			branding: artifactBrandSnapshotSchema.optional(),
		})
		.optional(),
	metadata: z
		.object({
			format: z.enum(["html", "json", "mermaid", "markdown"]).optional(),
			generatedByTool: z.string().optional(),
			conversationId: z.string().optional(),
			authoritySessionId: z.string().optional(),
			providerKeys: z.array(z.string()).optional(),
			sourceRunType: z.string().optional(),
			sourceRunId: z.string().optional(),
			/**
			 * Fabric MCP tools the frame's own script may call through the host
			 * page runtime (`window.fabric.call`). Versioned with the content,
			 * because the content is what calls them.
			 */
			runtime: z
				.object({ tools: z.array(z.string().min(1)).max(50) })
				.optional(),
		})
		.optional(),
});
