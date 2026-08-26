/**
 * Feature Prompt Configuration
 *
 * Generates features in Epic → Feature → Feature Item hierarchy format
 * with G/W/T acceptance criteria. No meta-documentation or templates.
 */

import type { DocumentPromptConfig } from "../types";
import {
	formatForbiddenSections,
	USER_STORY_REQUIREMENTS,
} from "./user-story-constants";

export const USER_STORY_PROMPT: DocumentPromptConfig = {
	id: "user_story",
	name: "Feature",

	persona: `You are generating a FEATURE DOCUMENT for THIS SPECIFIC PROJECT.

🛑 CRITICAL: Your output must use Epic → Feature → Feature Item hierarchy. Start immediately with # EPIC-001:

🚫 ABSOLUTELY FORBIDDEN - DO NOT CREATE:
${formatForbiddenSections()}
- Any introduction, preamble, or overview sections
- Any description of the project
- Any personas, goals, or "Primary Need" sections
- Any "Success Metrics" sections
- Any "Story Format Template" or template examples
- Any "Acceptance Criteria Patterns" explanations
- Any meta-documentation about features
- Any feature about "defining personas" or "creating templates"
- Any meta-feature about documentation, specifications, or story formats
- Features where role is "product team member" or "documentation writer"
- "F-001: ... Specification" or "F-001: ... Framework" patterns

✅ YOU MUST CREATE:
- 2-5 Epics (EPIC-001, EPIC-002, etc.) grouping related features
- 2-4 Features per Epic (FEAT-001, FEAT-002, etc.)
- ${USER_STORY_REQUIREMENTS.minStories}-${USER_STORY_REQUIREMENTS.maxStories}+ total feature items (F-001, F-002, etc.) across all features
- Each feature item with: Description + Acceptance Criteria + Notes / Links + Release Notes
- Features specific to THIS project's domain and requirements

Your output is a DOCUMENT OF FEATURES organized by Epics and Features, not a guide or template.`,

	sections: [
		{
			name: "Features",
			required: true,
			guidance: `Generate ${USER_STORY_REQUIREMENTS.minStories}-${USER_STORY_REQUIREMENTS.maxStories}+ actual features organized in Epic → Feature → Feature Item hierarchy.

Your EXACT output format:

# EPIC-001: [Epic Title]

[1-2 sentence epic description]

## FEAT-001: [Feature Title]

[1-2 sentence feature description]

### F-001: [Feature Item Title]

Description

As a [role],
I want [goal],
So that [benefit].

Acceptance Criteria

GIVEN [context]
WHEN [action]
THEN [result]
AND [additional result]

GIVEN [edge case context]
WHEN [action]
THEN [expected result]

Notes / Links

Designs:
API:
Test data:

Release Notes

[1-2 sentence plain language summary]

---

### F-002: [Next Feature Item Title]

[Same structure...]

---

## FEAT-002: [Next Feature Title]

[Feature description]

### F-003: [Feature Item Title]

[Same structure...]

---

# EPIC-002: [Next Epic Title]

[Epic description]

## FEAT-003: [Feature Title]

[Continue with more features and feature items...]

RULES:
- Group related feature items under the same Feature
- Group related features under the same Epic
- Use sequential numbering: EPIC-001/002, FEAT-001/002/003, F-001/002/003
- Acceptance criteria: use GIVEN/WHEN/THEN format, one scenario per GIVEN block
- Only include acceptance criteria scenarios that are applicable (main flow, edge cases, errors, permissions, tracking)
- Separate each feature item with --- horizontal rule
- NO bold markers (**) around keywords - use plain text
- Each feature item MUST have all four sections: Description, Acceptance Criteria, Notes / Links, Release Notes`,
		},
	],

	qualityChecklist: [
		"Document starts with # EPIC-001: - no preamble",
		"Features are organized in Epic → Feature → Feature Item hierarchy",
		"Feature item follows 'As a... I want... So that...' format",
		"Acceptance criteria use Given/When/Then format",
		"Notes / Links section present with Designs, API, Test data placeholders",
		"Release Notes section with 1-2 line plain language summary",
		"Feature item is specific to the project's actual features and requirements",
		"No meta-documentation, templates, or explanations included",
		"No bold markers (**) around keywords",
	],

	antiPatterns: [
		"Creating any introduction or overview section",
		"Including 'User Personas and Goals' tables",
		"Creating 'Story Format Template' sections",
		"Including 'Acceptance Criteria Patterns' explanations",
		"Adding 'Feature Sizing Guidelines' or XS/S/M/L/XL explanations",
		"Including INVEST Validation sections",
		"Adding Definition of Ready (DoR) sections",
		"Adding Definition of Done (DoD) sections",
		"Creating Epic Overview sections without actual features",
		"Adding Technical Considerations sections",
		"Including Summary or Conclusion sections",
		"Explaining how to write features instead of generating them",
		"Creating meta-documentation about features",
		"Providing generic examples instead of project-specific features",
		"Flat list of features without Epic/Feature grouping",
		"Using **bold** markers around GIVEN/WHEN/THEN or role names",
	],

	examples: {
		goodStory: `# EPIC-001: Fleet Management

Core vehicle and fleet tracking capabilities.

## FEAT-001: Vehicle Registration

Manage vehicle lifecycle from addition to retirement.

### F-001: Add New Vehicle to Fleet

Description

As a fleet manager,
I want to add a new vehicle to my fleet with details like make, model, VIN, and license plate,
So that I can track and manage it within the system.

Acceptance Criteria

GIVEN I am on the "Add Vehicle" page
WHEN I enter vehicle details (make, model, year, VIN, license plate) and submit
THEN the vehicle is created in the database
AND I see a success message "Vehicle added successfully"
AND the vehicle appears in my fleet list

GIVEN I submit the form with a duplicate VIN
WHEN the system validates the entry
THEN I see an error "A vehicle with this VIN already exists"
AND the form is not submitted

Notes / Links

Designs: [Link to Figma add vehicle form]
API: POST /api/vehicles
Test data: VIN: 1HGBH41JXMN109186

Release Notes

Fleet managers can now add new vehicles to their fleet by entering key details like make, model, VIN, and license plate for comprehensive tracking.

---

### F-002: View Vehicle Details

Description

As a fleet manager,
I want to view detailed information about any vehicle in my fleet,
So that I can quickly access maintenance history, registration status, and assignment details.

Acceptance Criteria

GIVEN I am on the fleet list page
WHEN I click on a vehicle row
THEN I see the vehicle detail page with make, model, year, VIN, license plate, and status

GIVEN the vehicle has maintenance records
WHEN I view the vehicle details
THEN I see a timeline of past maintenance events

Notes / Links

Designs:
API: GET /api/vehicles/:id
Test data:

Release Notes

Fleet managers can now view comprehensive vehicle details including maintenance history and registration status.`,

		goodAcceptanceCriteria: `Acceptance Criteria

GIVEN I am on the login page
WHEN I click "Forgot Password"
AND I enter my email address
AND I click "Send Reset Link"
THEN I receive an email within 2 minutes
AND the email contains a reset link valid for 24 hours
AND I see a confirmation message on screen

GIVEN I enter an invalid email format
WHEN I click "Send Reset Link"
THEN I see "Please enter a valid email address"
AND the form is not submitted

GIVEN I have requested 3 password resets in 1 hour
WHEN I request another reset
THEN I see "Too many requests, try again later"
AND no email is sent`,
	},

	additionalInstructions: `## 🛑 CRITICAL INSTRUCTIONS

Your output must start IMMEDIATELY with:

# EPIC-001: [First Epic Title]

DO NOT include ANY of the following before the first epic:
- Project descriptions
- Personas sections
- Goals sections
- Overview sections
- Any explanatory text

## 🚫 FORBIDDEN SECTIONS - INSTANT FAILURE:

${formatForbiddenSections()}
❌ Any introduction or preamble
❌ Flat list of features without Epic/Feature grouping

## ✅ EXACT HIERARCHY FORMAT:

# EPIC-001: [Epic Title]

[Epic description]

## FEAT-001: [Feature Title]

[Feature description]

### F-001: [Feature Item Title]

Description

As a [role],
I want [goal],
So that [benefit].

Acceptance Criteria

GIVEN [context]
WHEN [action]
THEN [result]
AND [additional result]

Notes / Links

Designs:
API:
Test data:

Release Notes

[1-2 sentence plain language summary]

---

### F-002: [Next Feature Item]

[Same structure...]

## FEAT-002: [Next Feature]

[Continue...]

# EPIC-002: [Next Epic]

[Continue with ${USER_STORY_REQUIREMENTS.minStories}-${USER_STORY_REQUIREMENTS.maxStories}+ total features.]

**START YOUR RESPONSE WITH: # EPIC-001:**`,
};
