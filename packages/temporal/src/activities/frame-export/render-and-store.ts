/** Compose existing content/render/storage helpers without putting PDF bytes in workflow history. */
import { Context } from "@temporalio/activity";
import { generatePDFActivity } from "./generate-pdf";
import {
	type GetFrameContentInput,
	getFrameContentActivity,
} from "./get-frame-content";
import { uploadToS3Activity } from "./upload-to-s3";
export async function renderAndStoreFrameExportActivity(
	input: GetFrameContentInput & {
		key: string;
		expiresAt: string;
		orientation: "portrait" | "landscape";
	},
): Promise<void> {
	const signal = Context.current().cancellationSignal;
	signal.throwIfAborted();
	const frame = await getFrameContentActivity(input);
	signal.throwIfAborted();
	const pdf = await generatePDFActivity({
		content: frame.document,
		orientation: input.orientation,
	});
	signal.throwIfAborted();
	await uploadToS3Activity({
		buffer: pdf,
		key: input.key,
		contentType: "application/pdf",
		managed: input,
	});
	signal.throwIfAborted();
}
