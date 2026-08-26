/**
 * Migration script to update PRD template to PM Standard v2 format.
 *
 * This script:
 * 1. Finds the existing prd_template SYSTEM prompt
 * 2. Creates a new version with PM Standard v2 format
 * 3. Updates bindings to use the new version
 *
 * Safe to run multiple times - checks for existing v2 content before migrating.
 *
 * Run with: npx tsx scripts/migrate-prd-template-v2.ts
 */

import { db } from "../prisma/client";

const PRD_TEMPLATE_V2_CONTENT = `## **PRD**

**Title:** {{projectName}}

**Owner:** {{#if author}}{{author}}{{else}}[PM Name]{{/if}}

**Status:** {{#if status}}{{status}}{{else}}Draft{{/if}}

**Target Release:** {{#if targetRelease}}{{targetRelease}}{{else}}[Quarter/Version]{{/if}}

**Links:** [Figma](link) · [Jira/Epics](link) · [Miro](link) · [Docs](link)

---

## **Benefit Hypothesis**

If we **[build {{projectName}}]** for **[target users]**, then **[measurable outcome]** improves because **[reason]**.

---

## **Overview**

- **Problem:** {{#if problemStatement}}{{problemStatement}}{{else}}[What's broken / slow / costly today? Quantify with numbers.]{{/if}}
- **Why now:** {{#if whyNow}}{{whyNow}}{{else}}[Trigger, urgency, or opportunity driving this work.]{{/if}}
- **Goal:**
{{#each goals}}
  - {{this}}
{{/each}}
{{#unless goals}}
  - [Specific goal 1]
  - [Specific goal 2]
  - [Specific goal 3 - max 3 goals]
{{/unless}}
- **Non-goals:**
{{#each nonGoals}}
  - {{this}}
{{/each}}
{{#unless nonGoals}}
  - [What we will NOT solve in this release]
  - [Another explicit exclusion]
{{/unless}}

---

## **Users / Personas**

- **Primary user:** {{#if primaryUser}}{{primaryUser}}{{else}}[Role/description of main user who benefits most]{{/if}}
- **Secondary user:** {{#if secondaryUser}}{{secondaryUser}}{{else}}[Other users who will use this]{{/if}}
- **Internal user (if any):** {{#if internalUser}}{{internalUser}}{{else}}[Internal teams affected]{{/if}}

---

## **Success Metrics**

| **Goal** | **Metric** |
| --- | --- |
{{#each kpis}}
| {{this.goal}} | {{this.metric}} |
{{/each}}
{{#unless kpis}}
| [Goal description] | [Specific metric with target] |
| [Goal description] | [Specific metric with target] |
| [Goal description] | [Specific metric with target] |
{{/unless}}

**How we'll measure:** {{#if measurementMethod}}{{measurementMethod}}{{else}}[events/logs/dashboard] + [owner team/person]{{/if}}

---

## **Scope**

### **In Scope**
{{#each inScope}}
- {{this}}
{{/each}}
{{#unless inScope}}
- [What WILL be built/delivered]
- [Feature or capability included]
- [Another included item]
{{/unless}}

### **Out of Scope**
{{#each outOfScope}}
- {{this}}
{{/each}}
{{#unless outOfScope}}
- [What will NOT be addressed in this release]
- [Deferred item]
- [Explicit exclusion]
{{/unless}}

---

## **Requirements**

### **Must Have**
{{#each mustHave}}
- {{this}}
{{/each}}
{{#unless mustHave}}
- [Critical requirement 1 - MVP cannot ship without this]
- [Critical requirement 2]
- [Critical requirement 3]
{{/unless}}

### **Nice to Have**
{{#each niceToHave}}
- {{this}}
{{/each}}
{{#unless niceToHave}}
- [Enhancement that can be deferred if needed]
- [Additional feature for later]
{{/unless}}

**Non-Functional (only what matters)**

- Performance: {{#if performanceReqs}}{{performanceReqs}}{{else}}[Specific targets - response time, throughput]{{/if}}
- Security/Privacy: {{#if securityReqs}}{{securityReqs}}{{else}}[Compliance requirements, data protection]{{/if}}
- Reliability: {{#if reliabilityReqs}}{{reliabilityReqs}}{{else}}[Uptime SLA, failover requirements]{{/if}}

---

## **Key Flows / Use Cases**

1. **Happy path:**
{{#if happyPath}}
   - {{happyPath}}
{{else}}
   - [Step-by-step ideal scenario when everything works]
   - [Expected outcome and timing]
{{/if}}

2. **Edge cases:**
{{#each edgeCases}}
   - {{this.scenario}}: {{this.handling}}
{{/each}}
{{#unless edgeCases}}
   - [Unusual but valid scenario 1: how to handle]
   - [Unusual but valid scenario 2: how to handle]
{{/unless}}

3. **Failure / recovery:**
{{#each failureRecovery}}
   - {{this.failure}}: {{this.recovery}}
{{/each}}
{{#unless failureRecovery}}
   - [What happens when X fails: recovery approach]
   - [What happens when Y fails: recovery approach]
{{/unless}}

---

## **Dependencies / Risks**

- **Dependencies:**
{{#each dependencies}}
  - {{this.team}}: {{this.deliverable}} (due {{this.due}})
{{/each}}
{{#unless dependencies}}
  - [Team/API/vendor]: [What they must deliver] (due [when])
  - [Another dependency with owner and timing]
{{/unless}}

- **Risks:**
{{#each risks}}
  - {{this.risk}} → Mitigation: {{this.mitigation}}
{{/each}}
{{#unless risks}}
  - [Risk description] → Mitigation: [How we address it]
  - [Another risk] → Mitigation: [Mitigation strategy]
{{/unless}}

---

## **Open Questions**

{{#each openQuestions}}
- {{this}}
{{/each}}
{{#unless openQuestions}}
- [Unresolved question needing stakeholder input]
- [Another question requiring research or decision]
{{/unless}}

---

## **Work Breakdown**

- **Epics:**
{{#each epics}}
  - {{this}}
{{/each}}
{{#unless epics}}
  - [Epic 1: Large body of work]
  - [Epic 2: Another major workstream]
{{/unless}}

- **Features:**
{{#each features}}
  - {{this}}
{{/each}}
{{#unless features}}
  - [Feature 1: Distinct capability]
  - [Feature 2: Another capability]
{{/unless}}

- **Stories / Tasks:**
{{#each stories}}
  - {{this}}
{{/each}}
{{#unless stories}}
  - [Specific task or story]
  - [Another task]
{{/unless}}

- **Spikes (if needed):**
{{#each spikes}}
  - {{this}}
{{/each}}
{{#unless spikes}}
  - [Research or exploration needed]
{{/unless}}

---

## **Stakeholders**

- **Business/Sponsor:** {{#if businessSponsor}}{{businessSponsor}}{{else}}[Name, Title]{{/if}}
- **PM/PO:** {{#if pmOwner}}{{pmOwner}}{{else}}[Name, Title]{{/if}}
- **Engineering:** {{#if engineeringLead}}{{engineeringLead}}{{else}}[Tech Lead Name] + [Team Name]{{/if}}
- **Design:** {{#if designLead}}{{designLead}}{{else}}[Designer Name]{{/if}}
- **QA:** {{#if qaLead}}{{qaLead}}{{else}}[QA Lead Name]{{/if}}
- **Data/Analytics:** {{#if analyticsLead}}{{analyticsLead}}{{else}}[Analytics Lead Name]{{/if}}
- **Security/Compliance:** {{#if securityLead}}{{securityLead}}{{else}}[Security Lead Name]{{/if}}
- **Support/Ops:** {{#if supportLead}}{{supportLead}}{{else}}[Support/Ops Lead Name]{{/if}}

---

## **Release Notes**

{{#if releaseNotes}}{{releaseNotes}}{{else}}[What shipped] + [who it helps] + [any limitations or upcoming features].{{/if}}`;

async function main() {
	console.log("Starting PRD template migration to PM Standard v2...\n");

	// Step 1: Find the existing prd_template SYSTEM prompt
	const prdPrompt = await db.prompt.findFirst({
		where: {
			key: "prd_template",
			scope: "SYSTEM",
		},
		include: {
			versions: {
				orderBy: { version: "desc" },
				take: 1,
			},
		},
	});

	if (!prdPrompt) {
		throw new Error(
			"No prd_template SYSTEM prompt found. Run the seed script first: pnpm --filter @repo/database seed:prompts",
		);
	}

	console.log(`✓ Found prd_template prompt: ${prdPrompt.id}`);

	const latestVersion = prdPrompt.versions[0];
	if (!latestVersion) {
		throw new Error("No versions found for prd_template prompt.");
	}

	console.log(`  Current version: ${latestVersion.version}`);

	// Step 2: Check if already migrated (content starts with PM Standard v2 format)
	if (latestVersion.content.startsWith("## **PRD**")) {
		console.log("\n✓ PRD template is already in PM Standard v2 format.");
		console.log("  No migration needed.");
		return;
	}

	// Step 3: Create a new version with PM Standard v2 content
	const newVersion = latestVersion.version + 1;
	console.log(
		`\n→ Creating new version ${newVersion} with PM Standard v2 format...`,
	);

	const createdVersion = await db.promptVersion.create({
		data: {
			promptId: prdPrompt.id,
			version: newVersion,
			content: PRD_TEMPLATE_V2_CONTENT,
			variables: {},
			createdBy: "migration-script",
		},
	});

	console.log(`✓ Created version ${newVersion}: ${createdVersion.id}`);

	// Step 4: Update prompt description
	await db.prompt.update({
		where: { id: prdPrompt.id },
		data: {
			description:
				"PM Standard v2 PRD template following industry best practices for product planning and stakeholder alignment",
		},
	});

	console.log("✓ Updated prompt description");

	// Step 5: Update bindings to use the new version
	const bindings = await db.promptBinding.findMany({
		where: {
			promptVersionId: latestVersion.id,
		},
	});

	if (bindings.length > 0) {
		console.log(
			`\n→ Updating ${bindings.length} binding(s) to use new version...`,
		);

		for (const binding of bindings) {
			await db.promptBinding.update({
				where: { id: binding.id },
				data: { promptVersionId: createdVersion.id },
			});
			console.log(
				`  ✓ Updated binding: ${binding.targetKey} / ${binding.documentType}`,
			);
		}
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("✓ Migration complete!");
	console.log("=".repeat(60));
	console.log("\nPRD documents will now use PM Standard v2 format with:");
	console.log("  - Benefit Hypothesis");
	console.log("  - Overview (Problem, Why now, Goals, Non-goals)");
	console.log("  - Users / Personas");
	console.log("  - Success Metrics (table format)");
	console.log("  - Scope (In Scope / Out of Scope)");
	console.log("  - Requirements (Must Have / Nice to Have / Non-Functional)");
	console.log("  - Key Flows / Use Cases");
	console.log("  - Dependencies / Risks");
	console.log(
		"  - Open Questions, Work Breakdown, Stakeholders, Release Notes",
	);
}

main()
	.catch((e) => {
		console.error("\n❌ Migration failed:", e);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});
