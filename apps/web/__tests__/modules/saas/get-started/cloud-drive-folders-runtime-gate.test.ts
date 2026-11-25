import { describe, expect, it } from "vitest";
import {
	type GsRuntimeGates,
	pageComponentsFor,
	pageForTab,
} from "../../../../modules/saas/get-started/lib/get-started-registry";

/**
 * OneDrive, SharePoint and Google Drive document folders
 * (`CLOUD_DRIVE_FOLDERS`, per organization) add a source to the Add Context dialog. The Context tab's
 * tour names them only while the feature is on; off, its copy is unchanged.
 */

const OFF: GsRuntimeGates = {
	publishingSuite: false,
	todoList: false,
	glossyEdition: false,
	proposalArtifact: false,
	parlumeMeetings: false,
	credentialManager: false,
	reportSuite: false,
	cloudDriveFolders: false,
};
const ON: GsRuntimeGates = { ...OFF, cloudDriveFolders: true };

function contextComponents(gates: GsRuntimeGates) {
	const page = pageForTab("context", gates);
	if (!page) {
		throw new Error("The Context tab has no tour");
	}
	return pageComponentsFor(page, gates);
}

const addContext = (gates: GsRuntimeGates) =>
	contextComponents(gates).find((c) => c.id === "context-add");

describe("Get Started — cloud drive folders runtime gate", () => {
	it("keeps the Add Context copy unchanged while the feature is off", () => {
		const off = addContext(OFF);
		expect(off?.body).not.toMatch(/OneDrive|SharePoint/);
		expect(off?.body).not.toMatch(/Google Drive/);
		expect(off?.body).toContain("Google Docs");
	});

	it("names OneDrive and SharePoint folders while it is on", () => {
		const on = addContext(ON);
		expect(on?.body).toContain("OneDrive and SharePoint folders");
		expect(on?.body).toContain("Google Drive folders");
		expect(on?.body).toContain("Google Docs");
		expect(on).toMatchObject({ id: "context-add", anchor: "context-add" });
	});

	it("leaves every other Context component alone", () => {
		const others = (gates: GsRuntimeGates) =>
			contextComponents(gates).filter((c) => c.id !== "context-add");
		expect(others(ON)).toEqual(others(OFF));
	});
});
