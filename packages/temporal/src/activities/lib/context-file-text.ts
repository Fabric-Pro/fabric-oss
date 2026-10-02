/**
 * An uploaded context file's text, the same for both owners of a context:
 * the project context processing activity (`../project-context-processing`)
 * and its company context run (`../company-context-processing`, Fizzy #2719)
 * download and extract it here, and chunk it with the same thresholds.
 */

import { extractionFactory } from "@repo/rag";
import { downloadFile } from "@repo/storage";

// Chunking thresholds (same as wizard processing)
export const CHUNKING_THRESHOLD = 2048;
export const DEFAULT_CHUNK_SIZE = 2048;
export const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Sanitize text content by removing null bytes and other problematic characters
 */
function sanitizeTextForStorage(text: string): string {
	return Array.from(text)
		.filter((char) => {
			const codePoint = char.codePointAt(0);
			if (codePoint === undefined) {
				return false;
			}

			return (
				codePoint !== 0 &&
				codePoint !== 0xfffd &&
				!(codePoint >= 0x01 && codePoint <= 0x08) &&
				codePoint !== 0x0b &&
				codePoint !== 0x0c &&
				!(codePoint >= 0x0e && codePoint <= 0x1f)
			);
		})
		.join("");
}

/** The stored file a context row points at. */
interface StoredContextFile {
	s3Path: string;
	s3Bucket: string | null;
	originalFilename: string | null;
	mimeType: string | null;
}

/**
 * Download the stored file and extract its text, falling back to the raw
 * bytes for plain text and markdown. Throws when the file cannot be read.
 * `safeHeartbeat` is told each phase as it starts.
 */
export async function downloadAndExtractText(
	file: StoredContextFile,
	run: {
		contextId: string;
		extractionStrategy: string;
		userId: string;
		organizationId: string | undefined;
		safeHeartbeat: (phase: string) => void;
	},
): Promise<{ extractedText: string; extractorUsed: string | undefined }> {
	const { contextId, safeHeartbeat } = run;

	// Step 3: Download from storage
	safeHeartbeat("downloading");
	console.log("[ProjectContextProcessing] Downloading from storage");
	if (!file.s3Bucket) {
		throw new Error(`No S3 bucket for context: ${contextId}`);
	}
	const downloadResult = await downloadFile(file.s3Path, {
		bucket: file.s3Bucket,
	});
	const buffer = downloadResult.data;
	console.log(
		`[ProjectContextProcessing] Downloaded ${file.originalFilename} (${buffer.length} bytes)`,
	);

	// Step 4: Extract text
	safeHeartbeat("extracting");
	console.log("[ProjectContextProcessing] Extracting text");
	try {
		const extractionResult = await extractionFactory.extract(
			buffer,
			file.originalFilename || "unknown",
			file.mimeType || "application/octet-stream",
			{
				strategy: run.extractionStrategy as
					| "local-only"
					| "external-only"
					| "prefer-external"
					| "cost-optimized"
					| "quality-optimized",
				userId: run.userId,
				organizationId: run.organizationId,
			},
		);
		const extractedText = sanitizeTextForStorage(extractionResult.text);
		const extractorUsed = extractionResult.extractorUsed;
		console.log(
			`[ProjectContextProcessing] Extracted ${extractedText.length} chars using ${extractorUsed}`,
		);
		return { extractedText, extractorUsed };
	} catch (extractionError) {
		// Fallback for plain text
		if (
			file.mimeType === "text/plain" ||
			file.mimeType === "text/markdown"
		) {
			const extractedText = sanitizeTextForStorage(
				buffer.toString("utf-8"),
			);
			console.log(
				`[ProjectContextProcessing] Fallback to direct text: ${extractedText.length} chars`,
			);
			return { extractedText, extractorUsed: "direct-text" };
		}
		throw new Error(
			`Failed to extract text: ${extractionError instanceof Error ? extractionError.message : "Unknown error"}`,
		);
	}
}
