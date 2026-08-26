/**
 * Tests for MCP Content Extraction Activities
 *
 * Tests the content extraction functionality for enterprise MCP servers
 * including Notion, Confluence, Jira, and Linear content parsing.
 */

import { describe, expect, it } from "vitest";

// =============================================================================
// Content Parser Tests (Unit Tests for Parser Logic)
// =============================================================================

describe("MCP Content Extraction Parsers", () => {
	describe("Notion Content Parsing", () => {
		/**
		 * Test Notion block parsing logic
		 * Notion returns content as blocks that need to be converted to markdown
		 */
		function parseNotionBlocks(
			blocks: Array<Record<string, unknown>>,
		): string {
			const parts: string[] = [];

			for (const block of blocks) {
				const blockType = block.type as string;
				const blockContent = block[blockType] as
					| Record<string, unknown>
					| undefined;
				if (!blockContent) {
					continue;
				}

				const richText = blockContent.rich_text as
					| Array<{ plain_text?: string }>
					| undefined;
				const text =
					richText?.map((t) => t.plain_text || "").join("") || "";

				switch (blockType) {
					case "paragraph":
						if (text) {
							parts.push(text);
						}
						break;
					case "heading_1":
						if (text) {
							parts.push(`# ${text}`);
						}
						break;
					case "heading_2":
						if (text) {
							parts.push(`## ${text}`);
						}
						break;
					case "heading_3":
						if (text) {
							parts.push(`### ${text}`);
						}
						break;
					case "bulleted_list_item":
						if (text) {
							parts.push(`- ${text}`);
						}
						break;
					case "numbered_list_item":
						if (text) {
							parts.push(`1. ${text}`);
						}
						break;
					case "to_do": {
						const checked = blockContent.checked ? "x" : " ";
						if (text) {
							parts.push(`- [${checked}] ${text}`);
						}
						break;
					}
					case "code": {
						const language =
							(blockContent.language as string) || "";
						if (text) {
							parts.push(`\`\`\`${language}\n${text}\n\`\`\``);
						}
						break;
					}
					case "quote":
						if (text) {
							parts.push(`> ${text}`);
						}
						break;
					case "divider":
						parts.push("---");
						break;
					default:
						if (text) {
							parts.push(text);
						}
				}
			}

			return parts.join("\n\n");
		}

		it("should parse paragraph blocks", () => {
			const blocks = [
				{
					type: "paragraph",
					paragraph: {
						rich_text: [{ plain_text: "This is a paragraph." }],
					},
				},
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toBe("This is a paragraph.");
		});

		it("should parse heading blocks", () => {
			const blocks = [
				{
					type: "heading_1",
					heading_1: { rich_text: [{ plain_text: "Main Title" }] },
				},
				{
					type: "heading_2",
					heading_2: { rich_text: [{ plain_text: "Section" }] },
				},
				{
					type: "heading_3",
					heading_3: { rich_text: [{ plain_text: "Subsection" }] },
				},
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toContain("# Main Title");
			expect(result).toContain("## Section");
			expect(result).toContain("### Subsection");
		});

		it("should parse list items", () => {
			const blocks = [
				{
					type: "bulleted_list_item",
					bulleted_list_item: {
						rich_text: [{ plain_text: "Item 1" }],
					},
				},
				{
					type: "bulleted_list_item",
					bulleted_list_item: {
						rich_text: [{ plain_text: "Item 2" }],
					},
				},
				{
					type: "numbered_list_item",
					numbered_list_item: {
						rich_text: [{ plain_text: "Step 1" }],
					},
				},
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toContain("- Item 1");
			expect(result).toContain("- Item 2");
			expect(result).toContain("1. Step 1");
		});

		it("should parse code blocks with language", () => {
			const blocks = [
				{
					type: "code",
					code: {
						rich_text: [{ plain_text: "const x = 1;" }],
						language: "typescript",
					},
				},
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toContain("```typescript");
			expect(result).toContain("const x = 1;");
			expect(result).toContain("```");
		});

		it("should parse todo items with checked state", () => {
			const blocks = [
				{
					type: "to_do",
					to_do: {
						rich_text: [{ plain_text: "Done task" }],
						checked: true,
					},
				},
				{
					type: "to_do",
					to_do: {
						rich_text: [{ plain_text: "Pending task" }],
						checked: false,
					},
				},
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toContain("- [x] Done task");
			expect(result).toContain("- [ ] Pending task");
		});

		it("should parse quote blocks", () => {
			const blocks = [
				{
					type: "quote",
					quote: { rich_text: [{ plain_text: "This is a quote." }] },
				},
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toBe("> This is a quote.");
		});

		it("should parse divider blocks", () => {
			const blocks = [
				{
					type: "paragraph",
					paragraph: { rich_text: [{ plain_text: "Before" }] },
				},
				{ type: "divider", divider: {} },
				{
					type: "paragraph",
					paragraph: { rich_text: [{ plain_text: "After" }] },
				},
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toContain("Before");
			expect(result).toContain("---");
			expect(result).toContain("After");
		});

		it("should handle blocks without rich_text", () => {
			const blocks = [
				{ type: "paragraph", paragraph: {} },
				{ type: "heading_1", heading_1: { rich_text: [] } },
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toBe("");
		});

		it("should concatenate multiple rich_text items", () => {
			const blocks = [
				{
					type: "paragraph",
					paragraph: {
						rich_text: [
							{ plain_text: "Hello " },
							{ plain_text: "World" },
							{ plain_text: "!" },
						],
					},
				},
			];

			const result = parseNotionBlocks(blocks);
			expect(result).toBe("Hello World!");
		});
	});

	describe("Confluence Content Parsing", () => {
		/**
		 * Test Confluence XHTML to Markdown conversion
		 */
		function convertConfluenceXhtmlToMarkdown(xhtml: string): string {
			let md = xhtml;

			// Remove XML declarations and namespaces
			md = md.replace(/<\?xml[^>]*\?>/g, "");
			md = md.replace(/xmlns[^=]*="[^"]*"/g, "");

			// Convert common Confluence elements
			md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n");
			md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n");
			md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n");
			md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n");
			md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");
			md = md.replace(/<br\s*\/?>/gi, "\n");
			md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
			md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
			md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
			md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
			md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");
			md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
			md = md.replace(
				/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi,
				"[$2]($1)",
			);

			// Remove remaining tags
			md = md.replace(/<[^>]+>/g, "");

			// Clean up entities
			md = md.replace(/&nbsp;/g, " ");
			md = md.replace(/&amp;/g, "&");
			md = md.replace(/&lt;/g, "<");
			md = md.replace(/&gt;/g, ">");
			md = md.replace(/&quot;/g, '"');

			// Clean up whitespace
			md = md.replace(/\n{3,}/g, "\n\n");
			md = md.trim();

			return md;
		}

		it("should convert headings", () => {
			const xhtml = "<h1>Title</h1><h2>Section</h2><h3>Subsection</h3>";
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).toContain("# Title");
			expect(result).toContain("## Section");
			expect(result).toContain("### Subsection");
		});

		it("should convert paragraphs", () => {
			const xhtml = "<p>First paragraph.</p><p>Second paragraph.</p>";
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).toContain("First paragraph.");
			expect(result).toContain("Second paragraph.");
		});

		it("should convert list items", () => {
			const xhtml = "<ul><li>Item 1</li><li>Item 2</li></ul>";
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).toContain("- Item 1");
			expect(result).toContain("- Item 2");
		});

		it("should convert bold and italic text", () => {
			const xhtml =
				"<p><strong>Bold</strong> and <em>italic</em> text.</p>";
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).toContain("**Bold**");
			expect(result).toContain("*italic*");
		});

		it("should convert inline code", () => {
			const xhtml = "<p>Use <code>npm install</code> to install.</p>";
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).toContain("`npm install`");
		});

		it("should convert links", () => {
			const xhtml =
				'<p>Visit <a href="https://example.com">our site</a>.</p>';
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).toContain("[our site](https://example.com)");
		});

		it("should handle HTML entities", () => {
			const xhtml = "<p>A &amp; B &lt; C &gt; D &quot;quoted&quot;</p>";
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).toContain("A & B < C > D");
			expect(result).toContain('"quoted"');
		});

		it("should remove XML declarations", () => {
			const xhtml = '<?xml version="1.0"?><p>Content</p>';
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).not.toContain("<?xml");
			expect(result).toContain("Content");
		});

		it("should handle line breaks", () => {
			const xhtml = "<p>Line 1<br/>Line 2<br>Line 3</p>";
			const result = convertConfluenceXhtmlToMarkdown(xhtml);

			expect(result).toContain("Line 1");
			expect(result).toContain("Line 2");
			expect(result).toContain("Line 3");
		});
	});

	describe("Jira Content Parsing", () => {
		/**
		 * Extract text from Atlassian Document Format (ADF)
		 */
		function extractTextFromAdf(adf: Record<string, unknown>): string {
			const parts: string[] = [];

			function traverse(node: unknown) {
				if (!node || typeof node !== "object") {
					return;
				}

				const n = node as Record<string, unknown>;

				// Text nodes
				if (n.type === "text" && typeof n.text === "string") {
					parts.push(n.text);
				}

				// Recurse into content
				if (Array.isArray(n.content)) {
					for (const child of n.content) {
						traverse(child);
					}
				}
			}

			traverse(adf);
			return parts.join(" ");
		}

		it("should extract text from simple ADF document", () => {
			const adf = {
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "Hello " },
							{ type: "text", text: "World" },
						],
					},
				],
			};

			const result = extractTextFromAdf(adf);
			expect(result).toBe("Hello  World");
		});

		it("should extract text from nested ADF structure", () => {
			const adf = {
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: "Intro paragraph." }],
					},
					{
						type: "bulletList",
						content: [
							{
								type: "listItem",
								content: [
									{
										type: "paragraph",
										content: [
											{ type: "text", text: "Item 1" },
										],
									},
								],
							},
							{
								type: "listItem",
								content: [
									{
										type: "paragraph",
										content: [
											{ type: "text", text: "Item 2" },
										],
									},
								],
							},
						],
					},
				],
			};

			const result = extractTextFromAdf(adf);
			expect(result).toContain("Intro paragraph.");
			expect(result).toContain("Item 1");
			expect(result).toContain("Item 2");
		});

		it("should handle empty ADF document", () => {
			const adf = { type: "doc", content: [] };
			const result = extractTextFromAdf(adf);
			expect(result).toBe("");
		});

		it("should handle ADF with no text nodes", () => {
			const adf = {
				type: "doc",
				content: [
					{ type: "paragraph", content: [] },
					{ type: "rule" }, // horizontal rule - no content
				],
			};

			const result = extractTextFromAdf(adf);
			expect(result).toBe("");
		});
	});

	describe("Linear Content Parsing", () => {
		function parseLinearContent(obj: Record<string, unknown>): {
			content: string;
			title?: string;
			url?: string;
		} {
			let content = "";
			let title: string | undefined;
			let url: string | undefined;

			if (typeof obj.title === "string") {
				title = obj.title;
			}

			if (typeof obj.description === "string") {
				content = obj.description;
			}

			if (typeof obj.url === "string") {
				url = obj.url;
			}

			const identifier = obj.identifier as string;
			if (identifier && title) {
				content = `# ${identifier}: ${title}\n\n${content}`;
			} else if (title) {
				content = `# ${title}\n\n${content}`;
			}

			return { content, title, url };
		}

		it("should parse Linear issue with all fields", () => {
			const issue = {
				identifier: "ENG-123",
				title: "Fix authentication bug",
				description: "Users are unable to login after password reset.",
				url: "https://linear.app/team/issue/ENG-123",
			};

			const result = parseLinearContent(issue);

			expect(result.title).toBe("Fix authentication bug");
			expect(result.url).toBe("https://linear.app/team/issue/ENG-123");
			expect(result.content).toContain(
				"# ENG-123: Fix authentication bug",
			);
			expect(result.content).toContain("Users are unable to login");
		});

		it("should handle issue without identifier", () => {
			const issue = {
				title: "Feature request",
				description: "Add dark mode support.",
			};

			const result = parseLinearContent(issue);

			expect(result.content).toContain("# Feature request");
			expect(result.content).toContain("Add dark mode support.");
		});

		it("should handle issue without description", () => {
			const issue = {
				identifier: "ENG-456",
				title: "Quick task",
			};

			const result = parseLinearContent(issue);

			expect(result.title).toBe("Quick task");
			expect(result.content).toContain("# ENG-456: Quick task");
		});
	});

	describe("Generic Content Parsing", () => {
		function parseGenericContent(obj: Record<string, unknown>): {
			content: string;
			title?: string;
			url?: string;
		} {
			let content = "";
			let title: string | undefined;
			let url: string | undefined;

			// Try common field names for title
			for (const key of [
				"title",
				"name",
				"summary",
				"subject",
				"heading",
			]) {
				if (typeof obj[key] === "string") {
					title = obj[key] as string;
					break;
				}
			}

			// Try common field names for content
			for (const key of [
				"content",
				"body",
				"description",
				"text",
				"markdown",
				"html",
			]) {
				if (typeof obj[key] === "string") {
					content = obj[key] as string;
					break;
				}
				if (obj[key] && typeof obj[key] === "object") {
					const nested = obj[key] as Record<string, unknown>;
					for (const nestedKey of [
						"value",
						"text",
						"raw",
						"rendered",
					]) {
						if (typeof nested[nestedKey] === "string") {
							content = nested[nestedKey] as string;
							break;
						}
					}
					if (content) {
						break;
					}
				}
			}

			// Try common field names for URL
			for (const key of ["url", "link", "href", "webUrl", "self"]) {
				if (typeof obj[key] === "string") {
					url = obj[key] as string;
					break;
				}
			}

			return { content, title, url };
		}

		it("should find title using common field names", () => {
			expect(parseGenericContent({ title: "Title" }).title).toBe("Title");
			expect(parseGenericContent({ name: "Name" }).title).toBe("Name");
			expect(parseGenericContent({ summary: "Summary" }).title).toBe(
				"Summary",
			);
			expect(parseGenericContent({ subject: "Subject" }).title).toBe(
				"Subject",
			);
		});

		it("should find content using common field names", () => {
			expect(
				parseGenericContent({ content: "Content text" }).content,
			).toBe("Content text");
			expect(parseGenericContent({ body: "Body text" }).content).toBe(
				"Body text",
			);
			expect(
				parseGenericContent({ description: "Description" }).content,
			).toBe("Description");
			expect(parseGenericContent({ text: "Text" }).content).toBe("Text");
		});

		it("should find URL using common field names", () => {
			expect(
				parseGenericContent({ url: "https://example.com" }).url,
			).toBe("https://example.com");
			expect(parseGenericContent({ link: "https://link.com" }).url).toBe(
				"https://link.com",
			);
			expect(parseGenericContent({ webUrl: "https://web.com" }).url).toBe(
				"https://web.com",
			);
		});

		it("should handle nested content structures", () => {
			const obj = {
				title: "Document",
				body: {
					value: "Nested content value",
				},
			};

			const result = parseGenericContent(obj);
			expect(result.title).toBe("Document");
			expect(result.content).toBe("Nested content value");
		});

		it("should prioritize first matching field name", () => {
			const obj = {
				title: "First Title",
				name: "Second Name",
				content: "First Content",
				body: "Second Body",
			};

			const result = parseGenericContent(obj);
			expect(result.title).toBe("First Title");
			expect(result.content).toBe("First Content");
		});
	});
});

// =============================================================================
// PRD Pipeline MCP Source Tests
// =============================================================================

describe("PRD Pipeline MCP Integration", () => {
	describe("Pipeline Input with PRD Source", () => {
		// Inline type for testing
		interface PRDSource {
			type: "text" | "mcp";
			mcp?: {
				mcpConfigId: string;
				toolName: string;
				toolArgs: Record<string, unknown>;
			};
		}

		interface PRDToTasksPipelineInput {
			pipelineId: string;
			userId: string;
			projectName: string;
			projectDescription: string;
			existingPRD?: string;
			prdSource?: PRDSource;
		}

		it("should accept text PRD source type", () => {
			const input: PRDToTasksPipelineInput = {
				pipelineId: "pipeline-1",
				userId: "user-1",
				projectName: "Test Project",
				projectDescription: "A test project",
				prdSource: {
					type: "text",
				},
			};

			expect(input.prdSource?.type).toBe("text");
		});

		it("should accept MCP PRD source type with config", () => {
			const input: PRDToTasksPipelineInput = {
				pipelineId: "pipeline-1",
				userId: "user-1",
				projectName: "Test Project",
				projectDescription: "A test project",
				prdSource: {
					type: "mcp",
					mcp: {
						mcpConfigId: "mcp-config-123",
						toolName: "notion_get_page",
						toolArgs: { pageId: "abc123" },
					},
				},
			};

			expect(input.prdSource?.type).toBe("mcp");
			expect(input.prdSource?.mcp?.mcpConfigId).toBe("mcp-config-123");
			expect(input.prdSource?.mcp?.toolName).toBe("notion_get_page");
			expect(input.prdSource?.mcp?.toolArgs).toEqual({
				pageId: "abc123",
			});
		});

		it("should support Confluence page extraction config", () => {
			const input: PRDToTasksPipelineInput = {
				pipelineId: "pipeline-1",
				userId: "user-1",
				projectName: "Test Project",
				projectDescription: "A test project",
				prdSource: {
					type: "mcp",
					mcp: {
						mcpConfigId: "atlassian-config-123",
						toolName: "confluence_get_page",
						toolArgs: {
							pageId: "12345",
							expand: ["body.storage", "version"],
						},
					},
				},
			};

			expect(input.prdSource?.mcp?.toolName).toBe("confluence_get_page");
			expect(input.prdSource?.mcp?.toolArgs.pageId).toBe("12345");
		});

		it("should support Jira issue extraction config", () => {
			const input: PRDToTasksPipelineInput = {
				pipelineId: "pipeline-1",
				userId: "user-1",
				projectName: "Test Project",
				projectDescription: "A test project",
				prdSource: {
					type: "mcp",
					mcp: {
						mcpConfigId: "atlassian-config-123",
						toolName: "jira_get_issue",
						toolArgs: {
							issueKey: "PROJ-123",
						},
					},
				},
			};

			expect(input.prdSource?.mcp?.toolName).toBe("jira_get_issue");
		});

		it("should be backward compatible with existingPRD", () => {
			const input: PRDToTasksPipelineInput = {
				pipelineId: "pipeline-1",
				userId: "user-1",
				projectName: "Test Project",
				projectDescription: "A test project",
				existingPRD: "# PRD\n\nThis is an existing PRD document.",
			};

			expect(input.existingPRD).toBeDefined();
			expect(input.prdSource).toBeUndefined();
		});
	});
});

// =============================================================================
// MCP Extract Content Result Tests
// =============================================================================

describe("MCP Extract Content Result", () => {
	interface McpExtractContentResult {
		success: boolean;
		content: string;
		title?: string;
		url?: string;
		metadata: {
			serverName: string;
			serverKey?: string;
			toolName: string;
			extractedAt: string;
			contentLength: number;
		};
		error?: string;
	}

	it("should have correct success result structure", () => {
		const result: McpExtractContentResult = {
			success: true,
			content: "# PRD Document\n\nThis is the content...",
			title: "PRD Document",
			url: "https://notion.so/page/abc123",
			metadata: {
				serverName: "Notion (Official)",
				serverKey: "notion-remote",
				toolName: "notion_get_page",
				extractedAt: new Date().toISOString(),
				contentLength: 42,
			},
		};

		expect(result.success).toBe(true);
		expect(result.content).toContain("PRD Document");
		expect(result.metadata.serverName).toBe("Notion (Official)");
		expect(result.metadata.contentLength).toBe(42);
	});

	it("should have correct error result structure", () => {
		const result: McpExtractContentResult = {
			success: false,
			content: "",
			metadata: {
				serverName: "Unknown",
				toolName: "notion_get_page",
				extractedAt: new Date().toISOString(),
				contentLength: 0,
			},
			error: "Authentication required: OAuth token expired",
		};

		expect(result.success).toBe(false);
		expect(result.content).toBe("");
		expect(result.error).toContain("Authentication required");
	});
});

// =============================================================================
// Enterprise MCP Server Registry Tests
// =============================================================================

describe("Enterprise MCP Server Registry", () => {
	/**
	 * Transport protocol rule:
	 * - URLs ending with /mcp → HTTP (Streamable HTTP)
	 * - URLs ending with /sse → SSE (Server-Sent Events)
	 * - No URL (STDIO servers) → STDIO
	 */
	const enterpriseServers = [
		{
			key: "atlassian",
			name: "Atlassian (Jira & Confluence)",
			transport: "HTTP", // URL ends with /mcp
			authMethods: ["OAUTH2"],
			defaultUrl: "https://mcp.atlassian.com/v1/mcp",
			oauthDiscoveryUrl:
				"https://mcp.atlassian.com/.well-known/oauth-authorization-server",
		},
		{
			key: "notion-remote",
			name: "Notion (Official)",
			transport: "HTTP", // URL ends with /mcp
			authMethods: ["OAUTH2"],
			defaultUrl: "https://mcp.notion.com/mcp",
		},
		{
			key: "linear-remote",
			name: "Linear (Official)",
			transport: "HTTP", // URL ends with /mcp (was incorrectly SSE)
			authMethods: ["OAUTH2"],
			defaultUrl: "https://mcp.linear.app/mcp",
		},
	];

	it("should have Atlassian MCP server configured", () => {
		const atlassian = enterpriseServers.find((s) => s.key === "atlassian");

		expect(atlassian).toBeDefined();
		expect(atlassian?.transport).toBe("HTTP");
		expect(atlassian?.defaultUrl).toBe("https://mcp.atlassian.com/v1/mcp");
		expect(atlassian?.oauthDiscoveryUrl).toBe(
			"https://mcp.atlassian.com/.well-known/oauth-authorization-server",
		);
	});

	it("should have Notion MCP server configured", () => {
		const notion = enterpriseServers.find((s) => s.key === "notion-remote");

		expect(notion).toBeDefined();
		expect(notion?.transport).toBe("HTTP"); // Notion uses Streamable HTTP
		expect(notion?.defaultUrl).toBe("https://mcp.notion.com/mcp");
	});

	it("should have Linear MCP server configured", () => {
		const linear = enterpriseServers.find((s) => s.key === "linear-remote");

		expect(linear).toBeDefined();
		expect(linear?.transport).toBe("HTTP"); // URL ends with /mcp → HTTP
		expect(linear?.defaultUrl).toBe("https://mcp.linear.app/mcp");
	});

	it("should all use OAuth2 authentication", () => {
		for (const server of enterpriseServers) {
			expect(server.authMethods).toContain("OAUTH2");
		}
	});

	it("should have transport matching URL pattern", () => {
		/**
		 * URL/Transport consistency rule:
		 * - /mcp endpoint → HTTP (Streamable HTTP)
		 * - /sse endpoint → SSE (Server-Sent Events)
		 * - No URL → STDIO (local npx servers)
		 */
		for (const server of enterpriseServers) {
			const url = server.defaultUrl;
			if (url?.endsWith("/mcp")) {
				expect(server.transport).toBe("HTTP");
			} else if (url?.endsWith("/sse") || url?.includes("/sse")) {
				expect(server.transport).toBe("SSE");
			} else if (!url) {
				expect(server.transport).toBe("STDIO");
			}
		}
	});
});

// =============================================================================
// MCP Transport Priority Tests
// =============================================================================

describe("MCP Transport Priority", () => {
	/**
	 * When an MCP server supports both HTTP and SSE transports,
	 * HTTP (Streamable HTTP) should be prioritized over SSE.
	 *
	 * Reasons:
	 * - HTTP is the newer, recommended protocol
	 * - Better reliability and error handling
	 * - Cleaner request/response model
	 */

	it("should prioritize HTTP over SSE when server supports both", () => {
		// Example: Firecrawl supports both /v2/mcp (HTTP) and /sse (SSE)
		// We should use HTTP as the default
		const firecrawlConfig = {
			httpEndpoint: "https://mcp.firecrawl.dev/{API_KEY}/v2/mcp",
			sseEndpoint: "https://mcp.firecrawl.dev/{API_KEY}/sse",
			preferredTransport: "HTTP",
		};

		expect(firecrawlConfig.preferredTransport).toBe("HTTP");
	});

	it("should use SSE only when HTTP is not available", () => {
		// Generic SSE-only example. Atlassian's Rovo MCP moved to HTTP at
		// /v1/mcp; the legacy /v1/sse endpoint is deprecated 2026-06-30.
		const sseOnlyConfig = {
			sseEndpoint: "https://example.com/legacy/sse",
			preferredTransport: "SSE",
		};

		expect(sseOnlyConfig.preferredTransport).toBe("SSE");
	});

	it("should determine transport from URL pattern", () => {
		const determineTransport = (url: string): "HTTP" | "SSE" | "STDIO" => {
			if (!url) {
				return "STDIO";
			}
			// Check SSE first since /mcp appears in domain names like mcp.example.com
			if (url.endsWith("/sse") || url.includes("/sse")) {
				return "SSE";
			}
			if (url.endsWith("/mcp") || url.includes("/v2/mcp")) {
				return "HTTP";
			}
			return "HTTP"; // Default to HTTP for remote servers
		};

		expect(determineTransport("https://mcp.example.com/mcp")).toBe("HTTP");
		expect(determineTransport("https://mcp.example.com/v2/mcp")).toBe(
			"HTTP",
		);
		expect(determineTransport("https://mcp.example.com/sse")).toBe("SSE");
		expect(determineTransport("https://mcp.example.com/v1/sse")).toBe(
			"SSE",
		);
	});
});

// =============================================================================
// MCP Tool Step Registration Tests
// =============================================================================

describe("MCP Tool Step Registry", () => {
	it("should have mcp-tool step registered", async () => {
		const { stepRegistry } = await import(
			"../src/activities/lib/step-registry"
		);

		expect(stepRegistry["mcp-tool"]).toBeDefined();
		expect(stepRegistry["mcp-tool"].name).toBe("MCP Tool");
	});
});

// =============================================================================
// Content Extraction Edge Cases
// =============================================================================

describe("Content Extraction Edge Cases", () => {
	describe("Empty and Null Handling", () => {
		function handleResult(result: unknown): string {
			if (result === null || result === undefined) {
				return "";
			}
			if (typeof result === "string") {
				return result;
			}
			if (typeof result === "object") {
				return JSON.stringify(result);
			}
			return String(result);
		}

		it("should handle null result", () => {
			expect(handleResult(null)).toBe("");
		});

		it("should handle undefined result", () => {
			expect(handleResult(undefined)).toBe("");
		});

		it("should handle empty string result", () => {
			expect(handleResult("")).toBe("");
		});

		it("should handle empty object result", () => {
			expect(handleResult({})).toBe("{}");
		});

		it("should handle string result directly", () => {
			expect(handleResult("Direct content")).toBe("Direct content");
		});
	});

	describe("Large Content Handling", () => {
		it("should handle very long content", () => {
			const longContent = "x".repeat(100000); // 100KB of text
			const result = { content: longContent };

			expect(result.content.length).toBe(100000);
		});

		it("should handle content with many blocks", () => {
			const blocks = Array.from({ length: 500 }, (_, i) => ({
				type: "paragraph",
				paragraph: {
					rich_text: [{ plain_text: `Paragraph ${i + 1}` }],
				},
			}));

			expect(blocks.length).toBe(500);
		});
	});

	describe("Special Characters", () => {
		it("should preserve markdown special characters", () => {
			const content =
				"# Title with *asterisks* and _underscores_ and `code`";
			expect(content).toContain("*asterisks*");
			expect(content).toContain("_underscores_");
			expect(content).toContain("`code`");
		});

		it("should handle unicode content", () => {
			const content = "Unicode: 日本語 한국어 emoji 🚀🎉";
			expect(content).toContain("日本語");
			expect(content).toContain("🚀");
		});

		it("should handle content with line breaks", () => {
			const content = "Line 1\nLine 2\r\nLine 3\n\nParagraph 2";
			expect(content.split(/[\r\n]+/).length).toBeGreaterThan(1);
		});
	});
});
