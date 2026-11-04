// Unit tests for the workspace document upload error mapper.
//
// Covers one branch per row in the spec §6c decision-rules table plus the
// edge cases enumerated in spec §7.1 (null, undefined, unknown ORPC code,
// synthetic `{ status }` object). Each test asserts BOTH the resolved code
// AND the literal user-facing message, so accidental copy drift is caught.

import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { mapUploadError } from "../upload-error-mapper";

describe("mapUploadError", () => {
	describe("decision-rules branches (spec §6c)", () => {
		it("maps TypeError with /fetch/ message to NETWORK_OR_CORS", () => {
			const error = new TypeError("Failed to fetch");

			const result = mapUploadError(error);

			expect(result.code).toBe("NETWORK_OR_CORS");
			expect(result.userMessage).toBe(
				"Could not reach storage. Check your connection or contact support if this persists.",
			);
			expect(result.cause).toBe(error);
		});

		it("maps a Response with status 403 to STORAGE_REJECTED", () => {
			const response = new Response(null, { status: 403 });

			const result = mapUploadError(response);

			expect(result.code).toBe("STORAGE_REJECTED");
			expect(result.userMessage).toBe(
				"Upload was rejected by storage. The link may have expired — please try again.",
			);
			expect(result.cause).toBe(response);
		});

		it("maps a Response with status 413 to FILE_TOO_LARGE", () => {
			const response = new Response(null, { status: 413 });

			const result = mapUploadError(response);

			expect(result.code).toBe("FILE_TOO_LARGE");
			expect(result.userMessage).toBe(
				"File is too large for the storage configuration.",
			);
		});

		it("maps a Response with status 500 to STORAGE_UNAVAILABLE", () => {
			const response = new Response(null, { status: 500 });

			const result = mapUploadError(response);

			expect(result.code).toBe("STORAGE_UNAVAILABLE");
			expect(result.userMessage).toBe(
				"Storage service is unavailable. Please try again in a moment.",
			);
		});

		it("maps a Response with status 503 to STORAGE_UNAVAILABLE (upper range)", () => {
			const response = new Response(null, { status: 503 });

			const result = mapUploadError(response);

			expect(result.code).toBe("STORAGE_UNAVAILABLE");
			expect(result.userMessage).toBe(
				"Storage service is unavailable. Please try again in a moment.",
			);
		});

		it("maps an ORPCError UNAUTHORIZED to UNAUTHORIZED", () => {
			const error = new ORPCError("UNAUTHORIZED");

			const result = mapUploadError(error);

			expect(result.code).toBe("UNAUTHORIZED");
			expect(result.userMessage).toBe(
				"Your session has expired. Please sign in and try again.",
			);
		});

		it("maps an ORPCError FORBIDDEN to FORBIDDEN", () => {
			const error = new ORPCError("FORBIDDEN");

			const result = mapUploadError(error);

			expect(result.code).toBe("FORBIDDEN");
			expect(result.userMessage).toBe(
				"You do not have permission to upload to this workspace.",
			);
		});

		it("maps an ORPCError BAD_REQUEST to VALIDATION", () => {
			const error = new ORPCError("BAD_REQUEST");

			const result = mapUploadError(error);

			expect(result.code).toBe("VALIDATION");
			expect(result.userMessage).toBe(
				"This file did not pass validation. Check the file type and size.",
			);
		});

		it("maps an ORPCError INTERNAL_SERVER_ERROR to SERVER_ERROR", () => {
			const error = new ORPCError("INTERNAL_SERVER_ERROR");

			const result = mapUploadError(error);

			expect(result.code).toBe("SERVER_ERROR");
			expect(result.userMessage).toBe(
				"Something went wrong on our side. Please try again.",
			);
		});

		it("maps an unrecognized value to UNKNOWN", () => {
			const error = new Error("something arbitrary");

			const result = mapUploadError(error);

			expect(result.code).toBe("UNKNOWN");
			expect(result.userMessage).toBe("Upload failed. Please try again.");
			expect(result.cause).toBe(error);
		});
	});

	describe("edge cases", () => {
		it("maps null to UNKNOWN", () => {
			const result = mapUploadError(null);

			expect(result.code).toBe("UNKNOWN");
			expect(result.userMessage).toBe("Upload failed. Please try again.");
			expect(result.cause).toBeNull();
		});

		it("maps undefined to UNKNOWN", () => {
			const result = mapUploadError(undefined);

			expect(result.code).toBe("UNKNOWN");
			expect(result.userMessage).toBe("Upload failed. Please try again.");
			expect(result.cause).toBeUndefined();
		});

		it("maps an ORPCError with unknown .code to UNKNOWN", () => {
			// CONFLICT is a valid oRPC code but not in our mapping table, so it
			// should fall through to UNKNOWN.
			const error = new ORPCError("CONFLICT");

			const result = mapUploadError(error);

			expect(result.code).toBe("UNKNOWN");
			expect(result.userMessage).toBe("Upload failed. Please try again.");
			expect(result.cause).toBe(error);
		});

		it("maps a synthetic { status: 403 } plain object to STORAGE_REJECTED", () => {
			// The uploader throws a synthetic error with a `status` field when
			// `!uploadResponse.ok` — the mapper must accept it just like a real
			// `Response`.
			const synthetic = { status: 403 };

			const result = mapUploadError(synthetic);

			expect(result.code).toBe("STORAGE_REJECTED");
			expect(result.userMessage).toBe(
				"Upload was rejected by storage. The link may have expired — please try again.",
			);
			expect(result.cause).toBe(synthetic);
		});
	});
});
