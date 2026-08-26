/**
 * PRD Template - PM Standard v2 Format
 *
 * This is the exact template that must be used for all PRD documents.
 * The AI must fill in the placeholders while maintaining the exact structure.
 */

export const PRD_TEMPLATE = `## **PRD**

**Title:** [Project/Feature Name]

**Owner:** [PM Name]

**Status:** Draft

**Target Release:** [Quarter/Version]

**Links:** [Figma](link) · [Jira/Epics](link) · [Miro](link) · [Docs](link)

---

## **Benefit Hypothesis**

If we **[build X]** for **[who]**, then **[measurable outcome]** improves because **[reason]**.

---

## **Overview**

- **Problem:** [What's broken / slow / costly today? Quantify with numbers.]
- **Why now:** [Trigger, urgency, or opportunity driving this work.]
- **Goal:**
  - [Specific goal 1]
  - [Specific goal 2]
  - [Specific goal 3 - max 3 goals]
- **Non-goals:**
  - [What we will NOT solve in this release]
  - [Another explicit exclusion]

---

## **Users / Personas**

- **Primary user:** [Role/description of main user who benefits most]
- **Secondary user:** [Other users who will use this]
- **Internal user (if any):** [Internal teams affected]

---

## **Success Metrics**

| **Goal** | **Metric** |
| --- | --- |
| [Goal description] | [Specific metric with target] |
| [Goal description] | [Specific metric with target] |
| [Goal description] | [Specific metric with target] |

**How we'll measure:** [events/logs/dashboard] + [owner team/person]

---

## **Scope**

### **In Scope**
- [What WILL be built/delivered]
- [Feature or capability included]
- [Another included item]

### **Out of Scope**
- [What will NOT be addressed in this release]
- [Deferred item]
- [Explicit exclusion]

---

## **Requirements**

### **Must Have**
- [Critical requirement 1 - MVP cannot ship without this]
- [Critical requirement 2]
- [Critical requirement 3]

### **Nice to Have**
- [Enhancement that can be deferred if needed]
- [Additional feature for later]

**Non-Functional (only what matters)**

- Performance: [Specific targets - response time, throughput]
- Security/Privacy: [Compliance requirements, data protection]
- Reliability: [Uptime SLA, failover requirements]

---

## **Key Flows / Use Cases**

1. **Happy path:**
   - [Step-by-step ideal scenario when everything works]
   - [Expected outcome and timing]

2. **Edge cases:**
   - [Unusual but valid scenario 1: how to handle]
   - [Unusual but valid scenario 2: how to handle]

3. **Failure / recovery:**
   - [What happens when X fails: recovery approach]
   - [What happens when Y fails: recovery approach]

---

## **Dependencies / Risks**

- **Dependencies:**
  - [Team/API/vendor]: [What they must deliver] (due [when])
  - [Another dependency with owner and timing]

- **Risks:**
  - [Risk description] → Mitigation: [How we address it]
  - [Another risk] → Mitigation: [Mitigation strategy]

---

## **Open Questions**

- [Unresolved question needing stakeholder input]
- [Another question requiring research or decision]

---

## **Work Breakdown**

- **Epics:**
  - [Epic 1: Large body of work]
  - [Epic 2: Another major workstream]

- **Features:**
  - [Feature 1: Distinct capability]
  - [Feature 2: Another capability]

- **Stories / Tasks:**
  - [Specific task or story]
  - [Another task]

- **Spikes (if needed):**
  - [Research or exploration needed]

---

## **Stakeholders**

- **Business/Sponsor:** [Name, Title]
- **PM/PO:** [Name, Title]
- **Engineering:** [Tech Lead Name] + [Team Name]
- **Design:** [Designer Name]
- **QA:** [QA Lead Name]
- **Data/Analytics:** [Analytics Lead Name]
- **Security/Compliance:** [Security Lead Name]
- **Support/Ops:** [Support/Ops Lead Name]

---

## **Release Notes**

[What shipped] + [who it helps] + [any limitations or upcoming features].
`;

/**
 * PRD required sections for validation
 */
export const PRD_REQUIRED_SECTIONS = [
	"PRD",
	"Benefit Hypothesis",
	"Overview",
	"Users / Personas",
	"Success Metrics",
	"Scope",
	"Requirements",
	"Key Flows / Use Cases",
	"Dependencies / Risks",
	"Stakeholders",
] as const;

/**
 * PRD optional sections
 */
export const PRD_OPTIONAL_SECTIONS = [
	"Open Questions",
	"Work Breakdown",
	"Release Notes",
] as const;

/**
 * PRD forbidden sections (sections that should NOT appear in a PRD)
 * These sections indicate the AI is NOT following PM Standard v2 format
 */
export const PRD_FORBIDDEN_SECTIONS = [
	// Common wrong sections
	"Executive Summary",
	"Product Vision",
	"Market Analysis",
	"Timeline and Milestones",
	"Appendix",
	"Appendices",
	"Approval and Sign-off",
	"Sign-off",
	"ROI Analysis",
	"Budget",
	"Investment",
	// Wrong section naming patterns
	"Project Overview",
	"Goals and Objectives",
	"User Stories", // Use "Key Flows / Use Cases" instead
	"Features and Requirements",
	"Risks and Mitigation", // Use "Dependencies / Risks" instead
	"Technical Requirements",
	"Functional Requirements",
	"Non-Functional Requirements", // Include under Requirements section
	"User Personas", // Use "Users / Personas" instead
	// Numbered section patterns (1., 2., etc.) are also forbidden
] as const;

/**
 * Format forbidden sections for prompt
 */
export function formatPrdForbiddenSections(): string {
	return PRD_FORBIDDEN_SECTIONS.map((section) => `- ❌ "${section}"`).join(
		"\n",
	);
}

/**
 * Get PRD override instructions for the prompt builder
 */
export function getPrdOverrideInstructions(): string {
	return `# 🚫 CRITICAL: PRD TEMPLATE FORMAT REQUIREMENTS

**YOU MUST USE THE EXACT TEMPLATE FORMAT BELOW. DO NOT DEVIATE.**

The PRD format is strictly defined. You MUST:

1. **START** with \`## **PRD**\` header followed by Title, Owner, Status, Target Release, Links
2. **INCLUDE** the exact sections in this exact order:
   - Benefit Hypothesis (with "If we [build X] for [who], then [outcome] because [reason]" format)
   - Overview (with Problem, Why now, Goal, Non-goals bullet points)
   - Users / Personas (with Primary user, Secondary user, Internal user)
   - Success Metrics (with Goal/Metric TABLE and "How we'll measure" line)
   - Scope (with "### **In Scope**" and "### **Out of Scope**" subsections)
   - Requirements (with "### **Must Have**", "### **Nice to Have**", and **Non-Functional** subsections)
   - Key Flows / Use Cases (with numbered Happy path, Edge cases, Failure/recovery)
   - Dependencies / Risks (with Dependencies and Risks bullet groups)
   - Stakeholders (with all role categories)

3. **DO NOT** create these forbidden sections:
${formatPrdForbiddenSections()}

4. **FOLLOW** the exact heading format: \`### **Section Name**\` for main sections

**If you create any forbidden sections or deviate from the template, you have FAILED.**

---

## EXACT TEMPLATE TO FOLLOW:

${PRD_TEMPLATE}

---

**Fill in the [placeholders] with project-specific content while maintaining the EXACT structure above.**
`;
}
