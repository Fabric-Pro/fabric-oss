import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { z } from "zod";

/**
 * Opt in with FABRIC_REPORT_LIVE_TEST=1 and run with playwright.report-live.config.ts.
 * Requires existing Portal/Temporal/full worker services and a configured live AI provider.
 * Fixture contract: an example-* organization/user, an ACTIVE example-report-* project,
 * one shared COMPLETE/GENERATED document containing FABRIC_REPORT_DELIVERY_42,
 * one shared ready TEXT note containing FABRIC_REPORT_CONTEXT_17, and one PRIVATE
 * TEXT note containing PRIVATE_REPORT_SECRET_EXCLUDED_99. Shared rows must predate
 * the current month. The owned Example template must use only Project knowledge
 * and ask its summary agent to retain the evidence markers. The test creates and
 * deletes only its report instance; fixture creation/cleanup belongs to the caller.
 * Under the FABRIC_REPORT_E2E_ prefix, supply URL, ORGANIZATION_ID,
 * ORGANIZATION_SLUG, PROJECT_ID, PROJECT_NAME, TEMPLATE_ID and COOKIES_FILE.
 * COOKIES_FILE is an existing private Playwright cookie-array JSON file; never
 * commit credentials. The test never changes providers, workers or schedules.
 */

const cookieSchema = z.array(
	z.object({
		name: z.string(),
		value: z.string(),
		domain: z.string(),
		path: z.string(),
		expires: z.number(),
		httpOnly: z.boolean(),
		secure: z.boolean(),
		sameSite: z.enum(["Strict", "Lax", "None"]),
	}),
);
const sourceSchema = z.object({
	id: z.string(),
	type: z.literal("fabric"),
	provider: z.literal("fabric_project"),
	operation: z.literal("project_knowledge"),
});
const executionSchema = z.object({
	id: z.string(),
	status: z.string(),
	artifacts: z.array(z.object({ id: z.string(), name: z.string() })),
});
const instanceSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	executions: z.array(executionSchema),
});

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing local report qualification setting: ${name}`);
	}
	return value;
}

test.describe("live Project knowledge report qualification", () => {
	test.skip(
		process.env.FABRIC_REPORT_LIVE_TEST !== "1",
		"Requires an explicitly authorized loopback Portal, full worker, synthetic evidence and live provider",
	);
	test("creates and executes through the public Portal route, then previews and downloads the cited result", async ({
		page,
		context,
	}, testInfo) => {
		test.setTimeout(240_000);
		const baseUrl = new URL(required("FABRIC_REPORT_E2E_URL"));
		expect(["localhost", "127.0.0.1"]).toContain(baseUrl.hostname);
		expect(baseUrl.protocol).toBe("http:");
		const organizationId = required("FABRIC_REPORT_E2E_ORGANIZATION_ID");
		const organizationSlug = required(
			"FABRIC_REPORT_E2E_ORGANIZATION_SLUG",
		);
		const projectId = required("FABRIC_REPORT_E2E_PROJECT_ID");
		const projectName = required("FABRIC_REPORT_E2E_PROJECT_NAME");
		const templateId = required("FABRIC_REPORT_E2E_TEMPLATE_ID");
		expect(organizationId).toMatch(/^example-/);
		expect(organizationSlug).toMatch(/^example-/);
		expect(projectId).toMatch(/^example-report-/);
		expect(projectName).toMatch(/^Example /);
		await context.addCookies(
			cookieSchema.parse(
				JSON.parse(
					await readFile(
						required("FABRIC_REPORT_E2E_COOKIES_FILE"),
						"utf8",
					),
				),
			),
		);
		const session = z
			.object({ user: z.object({ id: z.string() }) })
			.parse(
				await (
					await context.request.get(
						`${baseUrl.origin}/api/auth/get-session`,
					)
				).json(),
			);
		expect(session.user.id).toMatch(/^example-/);
		const rpc = async (name: string, input: Record<string, unknown>) => {
			const response = await context.request.post(
				`${baseUrl.origin}/api/rpc/${name}`,
				{
					data: { json: { organizationId, ...input } },
				},
			);
			expect(response.ok(), `${name} HTTP status`).toBe(true);
			return z.object({ json: z.unknown() }).parse(await response.json())
				.json;
		};
		const template = z
			.object({
				name: z.string(),
				userId: z.string(),
				organizationId: z.string(),
				definition: z.object({
					dataSources: z.array(sourceSchema).length(1),
				}),
			})
			.parse(await rpc("reports/templates/get", { id: templateId }));
		expect(template.name).toMatch(/^Example /);
		expect(template.userId).toBe(session.user.id);
		expect(template.organizationId).toBe(organizationId);

		const name = `Example delivery qualification ${randomUUID().slice(0, 8)}`;
		let instanceId: string | undefined;
		let executionId: string | undefined;
		let completed = false;
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			await page.goto(
				`${baseUrl.origin}/app/${organizationSlug}/report-templates/${templateId}/instances/new`,
			);
			await page.locator("#instance-name").waitFor();
			for (const buttonName of ["Don't show again", "Decline"]) {
				const button = page.getByRole("button", {
					name: buttonName,
					exact: true,
				});
				if (await button.isVisible()) {
					await button.click();
				}
			}
			await page.locator("#instance-name").fill(name);
			await page
				.getByLabel("Period to report on", { exact: true })
				.click();
			await page
				.getByRole("option", { name: "Month", exact: true })
				.click();
			await page.getByLabel("Report audience", { exact: true }).click();
			await page
				.getByRole("option", { name: projectName, exact: true })
				.click();
			const createdResponse = page.waitForResponse(
				(response) =>
					response
						.url()
						.includes("/api/rpc/reports/instances/create") &&
					response.request().method() === "POST",
			);
			await page
				.getByRole("button", { name: "Create report", exact: true })
				.click();
			const created = await createdResponse;
			expect(created.ok()).toBe(true);
			instanceId = z
				.object({ json: z.object({ id: z.string() }) })
				.parse(await created.json()).json.id;
			await page.waitForURL(`**/instances/${instanceId}`);
			await page.getByRole("heading", { name, exact: true }).waitFor();
			await expect(
				page.getByText("Project knowledge selected", { exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("button", {
					name: "Test connections",
					exact: true,
				}),
			).toHaveCount(0);
			const generate = page
				.getByRole("button", { name: "Generate Report", exact: true })
				.first();
			await expect(generate).toBeEnabled();
			let executeRequests = 0;
			page.on("request", (request) => {
				if (
					request.method() === "POST" &&
					request.url().includes("/api/rpc/reports/instances/execute")
				) {
					executeRequests++;
				}
			});
			const startedResponse = page.waitForResponse(
				(response) =>
					response
						.url()
						.includes("/api/rpc/reports/instances/execute") &&
					response.request().method() === "POST",
			);
			await generate.click();
			const started = await startedResponse;
			expect(started.ok()).toBe(true);
			const request = z
				.object({
					json: z.object({
						instanceId: z.string(),
						organizationId: z.string(),
						idempotencyKey: z.uuid(),
					}),
				})
				.parse(started.request().postDataJSON()).json;
			expect(request.instanceId).toBe(instanceId);
			expect(request.organizationId).toBe(organizationId);
			const admission = z
				.object({
					json: z.object({
						executionId: z.string(),
						workflowId: z.string(),
						startConfirmed: z.boolean(),
					}),
				})
				.parse(await started.json()).json;
			executionId = admission.executionId;
			expect(admission.startConfirmed).toBe(true);
			let instance = instanceSchema.parse(
				await rpc("reports/instances/get", { id: instanceId }),
			);
			await expect
				.poll(
					async () => {
						instance = instanceSchema.parse(
							await rpc("reports/instances/get", {
								id: instanceId,
							}),
						);
						return instance.executions.find(
							(execution) => execution.id === executionId,
						)?.status;
					},
					{ timeout: 120_000, intervals: [1000, 2000] },
				)
				.toBe("COMPLETED");
			completed = true;
			expect(executeRequests).toBe(1);
			const execution = instance.executions.find(
				(item) => item.id === executionId,
			);
			expect(execution?.artifacts).toHaveLength(1);
			const artifact = execution?.artifacts[0];
			if (!artifact) {
				throw new Error("Completed report has no persisted artifact");
			}
			const download = await context.request.get(
				`${baseUrl.origin}/api/reports/artifacts/${artifact.id}/download`,
			);
			expect(download.status()).toBe(200);
			expect(download.headers()["content-disposition"]).toContain(
				"attachment;",
			);
			const content = await download.text();
			expect(content).toContain("FABRIC_REPORT_DELIVERY_42");
			expect(content).toContain("FABRIC_REPORT_CONTEXT_17");
			expect(content).not.toContain("PRIVATE_REPORT_SECRET_EXCLUDED_99");
			expect(content).toContain("Evidence notice");
			expect(content).toContain(
				`projects/${projectId}?tab=context&source=`,
			);
			await page.reload();
			await page.getByRole("tab", { name: /Execution History/ }).click();
			await expect(
				page.getByText("Completed", { exact: true }).first(),
			).toBeVisible();
			await page
				.getByRole("button", {
					name: `View ${artifact.name}`,
					exact: true,
				})
				.click();
			const dialog = page.getByRole("dialog");
			await expect(dialog).toContainText("FABRIC_REPORT_DELIVERY_42");
			await expect(dialog).toContainText("FABRIC_REPORT_CONTEXT_17");
			await expect(dialog).not.toContainText(
				"PRIVATE_REPORT_SECRET_EXCLUDED_99",
			);
			await expect(
				dialog
					.getByRole("link", {
						name: "Example delivery notes",
						exact: true,
					})
					.first(),
			).toHaveAttribute(
				"href",
				new RegExp(
					`/app/${organizationSlug}/projects/${projectId}\\?tab=context&source=`,
				),
			);
			expect(errors).toEqual([]);
			await testInfo.attach("report-qualification-receipt", {
				body: JSON.stringify({
					instanceId,
					executionId,
					workflowId: admission.workflowId,
					artifactId: artifact.id,
					executeRequests,
					status: "COMPLETED",
					providerMocked: false,
					artifactSha256: createHash("sha256")
						.update(content)
						.digest("hex"),
				}),
				contentType: "application/json",
			});
		} finally {
			try {
				if (executionId && !completed) {
					await rpc("reports/instances/cancelExecution", {
						executionId,
					});
				}
			} finally {
				if (instanceId) {
					await rpc("reports/instances/delete", { id: instanceId });
				}
			}
		}
	});
});
