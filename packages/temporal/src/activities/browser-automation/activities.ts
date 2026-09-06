/**
 * Browser Automation Activities
 *
 * Temporal activities for browser operations using Playwright.
 * All activities are designed for multi-tenant isolation.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
	closeSession,
	createSession,
	generateSessionId,
	getSession,
	getStorageState,
} from "./session-manager";
import type {
	AuthenticateInput,
	BrowserActionResult,
	BrowserExtractionResult,
	CloseBrowserSessionInput,
	CreateBrowserSessionInput,
	ExecuteActionInput,
	ExtractContentInput,
	NavigateInput,
	TakeScreenshotInput,
} from "./types";

// =============================================================================
// S3 Client for Screenshot Uploads
// =============================================================================

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
	if (s3Client) {
		return s3Client;
	}

	const s3Endpoint = process.env.S3_ENDPOINT;
	if (!s3Endpoint) {
		throw new Error("Missing env variable S3_ENDPOINT");
	}

	const s3Region = process.env.S3_REGION || "auto";
	const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID;
	const s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

	if (!s3AccessKeyId || !s3SecretAccessKey) {
		throw new Error(
			"Missing S3 credentials (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)",
		);
	}

	s3Client = new S3Client({
		region: s3Region,
		endpoint: s3Endpoint,
		forcePathStyle: true,
		credentials: {
			accessKeyId: s3AccessKeyId,
			secretAccessKey: s3SecretAccessKey,
		},
	});

	return s3Client;
}

async function uploadScreenshot(
	bucket: string,
	key: string,
	body: Buffer,
): Promise<string> {
	const client = getS3Client();

	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: "image/png",
		}),
	);

	// Return the S3 URL
	const endpoint = process.env.S3_ENDPOINT || "";
	return `${endpoint}/${bucket}/${key}`;
}

// =============================================================================
// Session Activities
// =============================================================================

/**
 * Create a new browser session
 */
export async function createBrowserSession(
	input: CreateBrowserSessionInput,
): Promise<{ sessionId: string }> {
	console.log(`[Browser] Creating session for task ${input.taskId}`);

	const sessionId = generateSessionId(input.userId, input.organizationId);

	await createSession(
		sessionId,
		input.userId,
		input.organizationId,
		input.options,
	);

	return { sessionId };
}

/**
 * Close a browser session
 */
export async function closeBrowserSession(
	input: CloseBrowserSessionInput,
): Promise<{ success: boolean; storageState?: unknown }> {
	console.log(`[Browser] Closing session ${input.sessionId}`);

	let storageState: unknown;

	if (input.persistStorage) {
		storageState = await getStorageState(
			input.sessionId,
			input.userId,
			input.organizationId,
		);
	}

	await closeSession(input.sessionId, input.userId, input.organizationId);

	return { success: true, storageState };
}

// =============================================================================
// Navigation Activities
// =============================================================================

/**
 * Navigate to a URL
 */
export async function navigateToUrl(
	input: NavigateInput,
): Promise<BrowserActionResult> {
	const startTime = Date.now();
	const session = getSession(
		input.sessionId,
		input.userId,
		input.organizationId,
	);

	if (!session) {
		return {
			success: false,
			action: { type: "navigate", url: input.url },
			error: `Session ${input.sessionId} not found`,
			duration: Date.now() - startTime,
		};
	}

	try {
		console.log(`[Browser] Navigating to ${input.url}`);

		await session.page.goto(input.url, {
			waitUntil: "domcontentloaded",
			timeout: input.timeout || 30000,
		});

		if (input.waitForSelector) {
			await session.page.waitForSelector(input.waitForSelector, {
				timeout: input.timeout || 30000,
			});
		}

		return {
			success: true,
			action: { type: "navigate", url: input.url },
			output: {
				url: session.page.url(),
				title: await session.page.title(),
			},
			duration: Date.now() - startTime,
		};
	} catch (error) {
		return {
			success: false,
			action: { type: "navigate", url: input.url },
			error: error instanceof Error ? error.message : "Navigation failed",
			duration: Date.now() - startTime,
		};
	}
}

// =============================================================================
// Action Activities
// =============================================================================

/**
 * Execute a browser action (click, type, select, etc.)
 */
export async function executeAction(
	input: ExecuteActionInput,
): Promise<BrowserActionResult> {
	const startTime = Date.now();
	const session = getSession(
		input.sessionId,
		input.userId,
		input.organizationId,
	);

	if (!session) {
		return {
			success: false,
			action: input.action,
			error: `Session ${input.sessionId} not found`,
			duration: Date.now() - startTime,
		};
	}

	const { action } = input;

	try {
		switch (action.type) {
			case "click": {
				if (!action.selector) {
					throw new Error("Selector required for click action");
				}
				await session.page.click(action.selector);
				break;
			}

			case "type": {
				if (!action.selector) {
					throw new Error("Selector required for type action");
				}
				if (!action.value) {
					throw new Error("Value required for type action");
				}
				await session.page.fill(action.selector, action.value);
				break;
			}

			case "select": {
				if (!action.selector) {
					throw new Error("Selector required for select action");
				}
				if (!action.value) {
					throw new Error("Value required for select action");
				}
				await session.page.selectOption(action.selector, action.value);
				break;
			}

			case "wait": {
				if (action.waitFor?.selector) {
					await session.page.waitForSelector(
						action.waitFor.selector,
						{
							timeout: action.waitFor.timeout || 30000,
							state: action.waitFor.state || "visible",
						},
					);
				} else {
					await session.page.waitForTimeout(
						action.waitFor?.timeout || 1000,
					);
				}
				break;
			}

			case "scroll": {
				const direction = action.scroll?.direction || "down";
				const amount = action.scroll?.amount || 500;
				await session.page.evaluate(
					({ dir, amt }) => {
						const x =
							dir === "left" ? -amt : dir === "right" ? amt : 0;
						const y =
							dir === "up" ? -amt : dir === "down" ? amt : 0;
						window.scrollBy(x, y);
					},
					{ dir: direction, amt: amount },
				);
				break;
			}

			case "evaluate": {
				if (!action.script) {
					throw new Error("Script required for evaluate action");
				}
				const result = await session.page.evaluate(action.script);
				return {
					success: true,
					action,
					output: result,
					duration: Date.now() - startTime,
				};
			}

			default:
				throw new Error(`Unknown action type: ${action.type}`);
		}

		return {
			success: true,
			action,
			duration: Date.now() - startTime,
		};
	} catch (error) {
		return {
			success: false,
			action,
			error: error instanceof Error ? error.message : "Action failed",
			duration: Date.now() - startTime,
		};
	}
}

// =============================================================================
// Extraction Activities
// =============================================================================

/**
 * Extract content from page using selectors
 */
export async function extractContent(
	input: ExtractContentInput,
): Promise<BrowserExtractionResult> {
	const session = getSession(
		input.sessionId,
		input.userId,
		input.organizationId,
	);

	if (!session) {
		throw new Error(`Session ${input.sessionId} not found`);
	}

	const results: BrowserExtractionResult = {};

	for (const extractor of input.extractors) {
		try {
			if (extractor.multiple) {
				const elements = await session.page.$$(extractor.selector);
				const values: string[] = [];

				for (const element of elements) {
					let value: string | null = null;

					if (extractor.attribute) {
						value = await element.getAttribute(extractor.attribute);
					} else if (extractor.transform === "html") {
						value = await element.innerHTML();
					} else {
						value = await element.textContent();
					}

					if (value) {
						values.push(value.trim());
					}
				}

				results[extractor.name] = values;
			} else {
				const element = await session.page.$(extractor.selector);

				if (element) {
					let value: string | null = null;

					if (extractor.attribute) {
						value = await element.getAttribute(extractor.attribute);
					} else if (extractor.transform === "html") {
						value = await element.innerHTML();
					} else {
						value = await element.textContent();
					}

					results[extractor.name] = value?.trim() || null;
				} else {
					results[extractor.name] = null;
				}
			}
		} catch (error) {
			console.error(
				`[Browser] Extraction error for ${extractor.name}:`,
				error,
			);
			results[extractor.name] = null;
		}
	}

	return results;
}

// =============================================================================
// Screenshot Activities
// =============================================================================

/**
 * Take a screenshot and upload to S3
 */
export async function takeScreenshot(
	input: TakeScreenshotInput,
): Promise<{ url: string | null }> {
	const session = getSession(
		input.sessionId,
		input.userId,
		input.organizationId,
	);

	if (!session) {
		throw new Error(`Session ${input.sessionId} not found`);
	}

	try {
		const buffer = await session.page.screenshot({
			fullPage: input.fullPage ?? false,
			type: "png",
		});

		const filename = input.name || `screenshot-${Date.now()}`;
		const key = `browser-screenshots/${input.taskId}/${filename}.png`;
		const bucket =
			process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME || "fabric-uploads";

		const url = await uploadScreenshot(bucket, key, buffer);

		console.log(`[Browser] Screenshot uploaded: ${url}`);

		return { url };
	} catch (error) {
		console.error("[Browser] Screenshot failed:", error);
		return { url: null };
	}
}

// =============================================================================
// Authentication Activities
// =============================================================================

/**
 * Authenticate using stored credentials or MCP OAuth
 */
export async function authenticate(
	input: AuthenticateInput,
): Promise<BrowserActionResult> {
	const startTime = Date.now();
	const session = getSession(
		input.sessionId,
		input.userId,
		input.organizationId,
	);

	if (!session) {
		return {
			success: false,
			action: { type: "navigate" },
			error: `Session ${input.sessionId} not found`,
			duration: Date.now() - startTime,
		};
	}

	const { config } = input;

	try {
		// If using MCP OAuth tokens
		if (config.mcpConfigId) {
			// TODO: Implement MCP OAuth token injection
			// const mcpConfig = await getMCPConfig(config.mcpConfigId);
			// Inject cookies/tokens from MCP config
			throw new Error("MCP OAuth authentication not yet implemented");
		}

		// Form-based login
		if (config.credentials?.type === "form") {
			const {
				usernameSelector,
				passwordSelector,
				submitSelector,
				username,
				password,
			} = config.credentials;

			if (!usernameSelector || !passwordSelector || !submitSelector) {
				throw new Error(
					"Form selectors required for form authentication",
				);
			}
			if (!username || !password) {
				throw new Error(
					"Username and password required for form authentication",
				);
			}

			if (input.loginUrl) {
				await session.page.goto(input.loginUrl, {
					waitUntil: "domcontentloaded",
				});
			}

			await session.page.fill(usernameSelector, username);
			await session.page.fill(passwordSelector, password);
			await session.page.click(submitSelector);

			// Wait for navigation after login
			await session.page.waitForLoadState("networkidle");
		}

		// Basic auth
		if (config.credentials?.type === "basic") {
			const { username, password } = config.credentials;
			if (!username || !password) {
				throw new Error(
					"Username and password required for basic authentication",
				);
			}
			await session.context.setHTTPCredentials({ username, password });
		}

		return {
			success: true,
			action: { type: "navigate" },
			duration: Date.now() - startTime,
		};
	} catch (error) {
		return {
			success: false,
			action: { type: "navigate" },
			error:
				error instanceof Error
					? error.message
					: "Authentication failed",
			duration: Date.now() - startTime,
		};
	}
}
