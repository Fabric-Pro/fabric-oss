/**
 * What the iterative loop tells the model about images the user attached.
 *
 * The original wording told the model it MUST go looking for image-generation
 * tools and must NOT describe the image — so a vision model that had the pixels
 * refused to look at them. Under `orch-image-vision-prompt-v1` the model is told
 * to analyse what it can see and to reach for image tools only when the user
 * asks for an image to be made or changed. The `false` branches return the
 * original text exactly, so histories recorded before the change replay as they
 * ran.
 */

export function attachedImagesUserNote(
	storagePaths: string[],
	visionPrompt: boolean,
): string {
	if (!visionPrompt) {
		return `\n\n[ATTACHED IMAGES: ${storagePaths.length} image(s). Storage paths: ${storagePaths.join(", ")}. Use fabric_generate_image with the storage path as inputImage parameter for image editing/modification tasks.]`;
	}
	return `\n\n[ATTACHED IMAGES: ${storagePaths.length} image(s). Storage paths: ${storagePaths.join(", ")}. These paths are only for image tools — pass one as fabric_generate_image's inputImage when the user asks to edit or modify an image.]`;
}

export function attachedImagesSystemNote(visionPrompt: boolean): string {
	if (!visionPrompt) {
		return `\n\nIMPORTANT: The user has attached image(s). You MUST use the search_tools function to find image generation/editing tools (e.g. search for "image generation") before responding. Do NOT describe images textually — use the discovered tool to process or generate images.`;
	}
	return "\n\nThe user has attached image(s). If the image content is included in the message, look at it and describe, read or analyse it directly to answer — you do not need a tool to see it. If it is not included, work from the attached description. Use image generation or editing tools (find them with search_tools) only when the user asks you to create a new image or modify the attached one.";
}
