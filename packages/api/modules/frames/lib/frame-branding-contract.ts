import { artifactBrandSelectionSchema } from "@repo/utils/artifact-brand-snapshot";
import { z } from "zod";

export const frameBrandingApplySchema = artifactBrandSelectionSchema.extend({
	expectedUpdatedAt: z.string().datetime({ offset: true }),
});
