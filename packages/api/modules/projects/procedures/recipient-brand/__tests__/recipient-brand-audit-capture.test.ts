/**
 * How each recipient brand write reaches the audit log (KTD24).
 *
 * `fetch` is named like a read, so activity capture drops it — the procedure
 * records the curated `project.recipient_brand.fetched` itself (pinned in
 * `fetch-recipient-brand.test.ts`). `createLogoUploadUrl` is not named like a
 * read and records nothing curated, so activity capture is what records the
 * issuance. Renaming either route changes which of those holds, which is why
 * the paths are pinned here against the real capture decision.
 */
import { describe, expect, it } from "vitest";
import {
	hasReadShapedName,
	shouldCapture,
} from "../../../../../orpc/middleware/audit-activity-middleware";

describe("recipient brand audit capture", () => {
	it("activity capture records the upload-URL issuance", () => {
		const path = ["projects", "recipientBrand", "createLogoUploadUrl"];
		expect(
			shouldCapture({
				method: "POST",
				readShapedName: hasReadShapedName(path),
			}),
		).toBe(true);
	});

	it("activity capture drops the fetch, which records its curated action instead", () => {
		const path = ["projects", "recipientBrand", "fetch"];
		expect(
			shouldCapture({
				method: "POST",
				readShapedName: hasReadShapedName(path),
			}),
		).toBe(false);
	});

	it("the confirmation and the Brand kit update are captured (curated rows dedupe them)", () => {
		for (const path of [
			["projects", "recipientBrand", "update"],
			["organizations", "brandKit", "update"],
		]) {
			expect(
				shouldCapture({
					method: "PUT",
					readShapedName: hasReadShapedName(path),
				}),
			).toBe(true);
		}
	});
});
