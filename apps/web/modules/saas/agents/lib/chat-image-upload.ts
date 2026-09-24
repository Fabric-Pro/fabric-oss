import { prepareImageForAi } from "@saas/projects/lib/image-upload-utils";
import { toast } from "sonner";
import { CHAT_IMAGE_UPLOAD_MAX_BYTES } from "./chat-image-upload-limit";

/**
 * Shrinks a pasted or dropped image to the provider's per-image budget,
 * exactly as the paperclip path does. Before this the paste path queued the
 * raw file, so a large screenshot reached the model over its cap and the
 * whole turn failed (review F37). Returns `null`, after telling the user
 * why, when the image cannot be brought within budget.
 */
export async function shapePastedImageForAi(file: File): Promise<File | null> {
	const shaped = await prepareImageForAi(file);
	if (!shaped.ok) {
		toast.error(shaped.error);
		return null;
	}
	return shaped.file;
}

/**
 * The message for a failed `upload-image` response. The platform's own 413
 * carries no JSON, so `response.json()` threw and the user saw only
 * "Failed to upload"; the route's JSON errors carry `error`.
 */
export function describeImageUploadFailure(
	status: number,
	body: unknown,
	name: string,
): string {
	const serverMessage =
		body && typeof (body as { error?: unknown }).error === "string"
			? (body as { error: string }).error
			: undefined;
	if (serverMessage) {
		return `Couldn't upload ${name}: ${serverMessage}`;
	}
	if (status === 413) {
		return `Couldn't upload ${name}: the image is larger than ${Math.round(CHAT_IMAGE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB. Try a smaller crop or a JPEG.`;
	}
	return `Couldn't upload ${name}.`;
}

/** An upload failure whose message is already fit to show the user. */
export class ImageUploadError extends Error {
	override name = "ImageUploadError";
}
