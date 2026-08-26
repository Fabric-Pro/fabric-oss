/**
 * Tests the Zod validation schema used in ForceChangePasswordForm.
 *
 * The schema is mirrored here (it is defined inside the component
 * closure with translation-bound messages). We test the validation
 * rules themselves, not the translated messages.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

const formSchema = z
	.object({
		currentPassword: z.string().min(1),
		newPassword: z
			.string()
			.min(8, "Password must be at least 8 characters"),
		confirmPassword: z.string().min(1),
	})
	.refine((data) => data.newPassword === data.confirmPassword, {
		message: "Passwords do not match",
		path: ["confirmPassword"],
	});

describe("ForceChangePasswordForm validation schema", () => {
	it("should reject newPassword under 8 characters", () => {
		const result = formSchema.safeParse({
			currentPassword: "current",
			newPassword: "short",
			confirmPassword: "short",
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			const paths = result.error.issues.map((i) => i.path.join("."));
			expect(paths).toContain("newPassword");
		}
	});

	it("should reject mismatched newPassword and confirmPassword", () => {
		const result = formSchema.safeParse({
			currentPassword: "current",
			newPassword: "validpassword1",
			confirmPassword: "differentpassword",
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			const paths = result.error.issues.map((i) => i.path.join("."));
			expect(paths).toContain("confirmPassword");
		}
	});

	it("should reject empty currentPassword", () => {
		const result = formSchema.safeParse({
			currentPassword: "",
			newPassword: "validpassword1",
			confirmPassword: "validpassword1",
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			const paths = result.error.issues.map((i) => i.path.join("."));
			expect(paths).toContain("currentPassword");
		}
	});

	it("should accept valid data with matching passwords of 8+ characters", () => {
		const result = formSchema.safeParse({
			currentPassword: "oldpassword",
			newPassword: "newpassword123",
			confirmPassword: "newpassword123",
		});

		expect(result.success).toBe(true);
	});

	it("should accept password of exactly 8 characters", () => {
		const result = formSchema.safeParse({
			currentPassword: "old",
			newPassword: "12345678",
			confirmPassword: "12345678",
		});

		expect(result.success).toBe(true);
	});
});
