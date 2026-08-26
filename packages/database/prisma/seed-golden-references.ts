/**
 * Seed Golden References for Document Evaluation
 *
 * This script creates golden reference documents for each document type.
 * These references are used to evaluate generated documents for quality.
 *
 * Run with: npx tsx prisma/seed-golden-references.ts
 */

import type { ProjectDocumentType } from "./client";
import { db, type Prisma } from "./client";

interface GoldenReferenceData {
	documentType: ProjectDocumentType;
	name: string;
	description: string;
	requiredSections: string[];
	keyPhrases: string[];
	content: string;
	projectContext: Prisma.InputJsonValue;
}

const GOLDEN_REFERENCES: GoldenReferenceData[] = [
	// PRD Golden Reference - PM Standard v2 Format
	{
		documentType: "PRD",
		name: "PRD - SaaS Product Template",
		description:
			"Golden reference for Product Requirements Documents following PM Standard v2 format (EVAL_VERSION 3).",
		requiredSections: [
			"benefit_hypothesis",
			"summary",
			"users",
			"goals",
			"scope",
			"requirements",
			"key_flows",
			"risks",
			"stakeholders",
		],
		keyPhrases: [
			// PRD FORMAT: Benefit Hypothesis
			"if we",
			"then",
			"because",
			"benefit hypothesis",
			"measurable outcome",
			// PRD FORMAT: Overview
			"problem",
			"why now",
			"goal",
			"non-goals",
			"non goals",
			// PRD FORMAT: Users/Personas
			"primary user",
			"secondary user",
			"internal user",
			"user persona",
			"target audience",
			// PRD FORMAT: Success Metrics
			"success metrics",
			"how we'll measure",
			"metric",
			"KPI",
			"dashboard",
			// PRD FORMAT: Scope
			"in scope",
			"out of scope",
			// PRD FORMAT: Requirements
			"must have",
			"nice to have",
			"non-functional",
			"performance",
			"security",
			"reliability",
			// PRD FORMAT: Key Flows
			"happy path",
			"edge cases",
			"failure",
			"recovery",
			// PRD FORMAT: Dependencies/Risks
			"dependencies",
			"risks",
			"mitigation",
			// PRD FORMAT: Work Breakdown
			"epics",
			"features",
			"stories",
			"tasks",
			"spikes",
			// PRD FORMAT: Stakeholders
			"stakeholders",
			"business sponsor",
			"pm",
			"engineering",
			"design",
			"qa",
			// PRD FORMAT: Release Notes
			"release notes",
			"what shipped",
		],
		projectContext: {
			name: "Sample SaaS Application",
			techStack: ["React", "Node.js", "PostgreSQL"],
			features: ["authentication", "dashboard", "reporting"],
			projectTypes: ["web", "saas"],
		},
		content: `## **PRD**

**Title:** Team Collaboration Platform

**Owner:** Jane Smith

**Status:** Review

**Target Release:** Q2 2024 (v2.5.0)

**Links:** [Figma](https://figma.com) · [Jira Epic](https://jira.com) · [Research Docs](https://docs.com)

---

### **Benefit Hypothesis**

If we **build a real-time collaboration platform** for **distributed product teams**, then **coordination time decreases by 60%** because **async status updates eliminate 80% of sync meetings**.

---

### **Overview**

- **Problem:** Modern teams waste 8+ hours/week in coordination overhead. Status meetings consume 30% of PM time. Manual reporting leads to stale data and delayed decisions. Current tools are fragmented (Slack for chat, Jira for tasks, Confluence for docs).
- **Why now:** Remote work is permanent for 40% of teams. Competitors launched integrated solutions in Q4. Customer churn increased 15% citing "too many tools."
- **Goal:**
  - Unified workspace for projects, tasks, and communication
  - Reduce coordination time from 8 hrs/week to 3 hrs/week
  - Achieve 70% feature adoption within 90 days
- **Non-goals:**
  - Full-featured time tracking (integrate with existing tools)
  - CI/CD pipeline management (defer to specialized tools)
  - Offline-first functionality (Phase 2)

---

### **Users / Personas**

- **Primary user:** Project managers coordinating 3-5 concurrent projects across distributed teams. Need single source of truth and automated reporting.
- **Secondary user:** Developers and designers who update task status and communicate progress. Need minimal friction and keyboard shortcuts.
- **Internal user (if any):** Customer Success team monitoring adoption metrics and helping onboard new teams.

---

### **Success Metrics**

| **Goal** | **Metric** |
| --- | --- |
| Reduce coordination overhead | Avg coordination time < 3 hrs/week (from 8 hrs) |
| Increase visibility | 80% of stakeholders check dashboard weekly |
| Improve adoption | 70% DAU/MAU ratio within 90 days |
| User satisfaction | NPS score > 50 |

**How we'll measure:** Amplitude analytics for usage metrics, in-app NPS survey monthly, time-tracking integration for coordination time. Owned by Product Analytics team.

---

### **Scope**

## **In Scope**
- Project and task management with customizable workflows
- Real-time collaboration and @mentions
- Automated status dashboards and reports
- Integration with Slack, GitHub, and Google Workspace
- Mobile-responsive web application

## **Out of Scope**
- Native mobile apps (Phase 2)
- Time tracking (integrate with Harvest/Toggl)
- Video conferencing (integrate with Zoom/Meet)
- Document editing (defer to Google Docs/Notion)
- SSO/SAML (Enterprise tier, Phase 2)

---

### **Requirements**

## **Must Have**
- Create projects with customizable workflow stages
- Add/edit/delete tasks with assignees, due dates, and priority
- Real-time task status updates across all connected clients
- @mention team members in comments with notifications
- Dashboard showing project health and task progress
- Export reports to PDF and CSV

## **Nice to Have**
- Kanban and Gantt view options
- Recurring task templates
- Bulk task operations
- Custom fields per project type
- Slack bot for quick updates

**Non-Functional (only what matters)**

- Performance: Page load < 2s, API response < 200ms p95
- Security/Privacy: SOC 2 Type II, GDPR compliant, data encrypted at rest
- Reliability: 99.9% uptime SLA, automated failover < 60s

---

### **Key Flows / Use Cases**

1. **Happy path:**
   - PM creates project → adds team members → creates tasks with workflow → team updates status → stakeholders view dashboard → automated weekly report sent
   - Total onboarding: < 10 minutes from signup to first project

2. **Edge cases:**
   - Task assigned to user who leaves organization: Reassign to project lead, notify PM
   - Project archived with active tasks: Warn user, offer bulk task migration
   - Workflow stage deleted with tasks in it: Move tasks to previous stage, notify assignees

3. **Failure / recovery:**
   - Real-time sync fails: Show offline indicator, queue updates, retry with exponential backoff
   - Report generation times out: Email user when complete, offer partial report download
   - Integration auth expires: Prompt re-auth, preserve pending syncs

---

### **Dependencies / Risks**

- **Dependencies:**
  - Platform team: WebSocket infrastructure (Week 3)
  - DevOps: Multi-region deployment (Week 5)
  - Legal: Terms of Service update for data processing (Week 2)
  - Design: Component library updates (Week 1)

- **Risks:**
  - WebSocket scalability under load → Mitigation: Load test at 10x expected traffic, have fallback polling
  - Low adoption due to migration friction → Mitigation: Import wizard for Jira/Trello, onboarding prompts
  - Integration partner API changes → Mitigation: Abstract integrations behind adapter layer

---

### **Open Questions**

- Should we support custom domains for Enterprise tier?
- What's the data retention policy for free tier users?
- Do we need audit logging for compliance before GA?

---

### **Work Breakdown**

- **Epics:**
  - Epic 1: Core Project Management
  - Epic 2: Real-time Collaboration
  - Epic 3: Reporting & Analytics
  - Epic 4: Integrations

- **Features:**
  - Project CRUD with workflows
  - Task management with status updates
  - Real-time sync engine
  - Dashboard builder
  - Report generator
  - Slack/GitHub integrations

- **Stories / Tasks:**
  - Design project creation wizard
  - Implement task drag-and-drop
  - Build WebSocket sync layer
  - Create dashboard widgets
  - Add CSV export functionality

- **Spikes (if needed):**
  - Evaluate WebSocket vs SSE for real-time updates
  - Research GDPR requirements for data export

---

### **Stakeholders**

- **Business/Sponsor:** Sarah Chen, VP Product
- **PM/PO:** Jane Smith, Senior Product Manager
- **Engineering:** Mike Lee, Tech Lead + Platform Team (5 engineers)
- **Design:** Alex Rivera, Senior UX Designer
- **QA:** Jordan Park, QA Lead
- **Data/Analytics:** Sam Johnson, Analytics Engineer
- **Security/Compliance:** Pat Williams, Security Architect
- **Support/Ops:** Chris Taylor, Customer Success Manager

---

### **Release Notes**

**Team Collaboration Platform v2.5** - Distributed teams can now manage projects, track tasks, and collaborate in real-time from a single workspace. Create customizable workflows, mention teammates, and get automated status reports.

Available as web app (mobile-responsive). Integrates with Slack, GitHub, and Google Workspace. Enterprise features (SSO, audit logs) coming in Phase 2.
`,
	},

	// Architecture Golden Reference
	{
		documentType: "ARCHITECTURE",
		name: "Architecture - Microservices Template",
		description:
			"Golden reference for Technical Architecture documents. Covers system design, component architecture, and deployment strategies.",
		requiredSections: ["summary", "technical", "data", "security"],
		keyPhrases: [
			"microservices",
			"API gateway",
			"load balancer",
			"database",
			"caching",
			"message queue",
			"containerization",
			"kubernetes",
			"CI/CD",
			"monitoring",
			"logging",
			"high availability",
			"disaster recovery",
		],
		projectContext: {
			name: "Distributed Platform",
			techStack: ["Node.js", "PostgreSQL", "Redis", "Kubernetes"],
			features: ["api", "async-processing", "real-time"],
			projectTypes: ["backend", "platform"],
		},
		content: `# Technical Architecture Document

## System Overview

This document describes the technical architecture for a scalable, microservices-based platform designed to handle high-volume data processing with real-time capabilities. The system is built on cloud-native principles and follows industry best practices for security, reliability, and maintainability.

### High-Level Architecture

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENT TIER                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │   Web App   │  │ Mobile App  │  │   API CLI   │                  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                  │
└─────────┼────────────────┼────────────────┼─────────────────────────┘
          │                │                │
┌─────────┼────────────────┼────────────────┼─────────────────────────┐
│         ▼                ▼                ▼                          │
│  ┌────────────────────────────────────────────────┐                 │
│  │              API GATEWAY / LOAD BALANCER        │                 │
│  │         (Authentication, Rate Limiting)         │                 │
│  └─────────────────────┬──────────────────────────┘                 │
│                        │                                             │
│  ┌─────────────────────┼──────────────────────────┐                 │
│  │                 SERVICE MESH                    │                 │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────────────┐ │                 │
│  │  │ User    │  │ Project │  │ Notification    │ │                 │
│  │  │ Service │  │ Service │  │ Service         │ │                 │
│  │  └────┬────┘  └────┬────┘  └────────┬────────┘ │                 │
│  └───────┼────────────┼────────────────┼──────────┘                 │
│          │            │                │            APPLICATION TIER │
└──────────┼────────────┼────────────────┼────────────────────────────┘
           │            │                │
┌──────────┼────────────┼────────────────┼────────────────────────────┐
│  ┌───────▼────────────▼────────────────▼───────┐                    │
│  │              MESSAGE QUEUE                   │                    │
│  │           (Async Processing)                 │                    │
│  └─────────────────────┬───────────────────────┘                    │
│                        │                                             │
│  ┌─────────────────────┼───────────────────────┐                    │
│  │  ┌──────────┐  ┌────▼─────┐  ┌───────────┐  │                    │
│  │  │PostgreSQL│  │  Redis   │  │   S3/Blob │  │   DATA TIER        │
│  │  │(Primary) │  │ (Cache)  │  │ (Storage) │  │                    │
│  │  └──────────┘  └──────────┘  └───────────┘  │                    │
│  └─────────────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

## Architecture Principles

1. **Microservices**: Each service is independently deployable and scalable
2. **API-First**: All functionality exposed via well-documented APIs
3. **Event-Driven**: Asynchronous communication for loose coupling
4. **Cloud-Native**: Designed for containerization and orchestration
5. **Security by Design**: Zero-trust architecture with defense in depth
6. **Observability**: Comprehensive logging, monitoring, and tracing

## Component Architecture

### API Gateway
- **Technology**: Kong / AWS API Gateway
- **Responsibilities**:
  - Request routing and load balancing
  - Authentication and authorization
  - Rate limiting and throttling
  - Request/response transformation
  - API versioning

### User Service
- **Technology**: Node.js + Express
- **Database**: PostgreSQL
- **Responsibilities**:
  - User registration and authentication
  - Profile management
  - Role-based access control

### Project Service
- **Technology**: Node.js + Express
- **Database**: PostgreSQL
- **Responsibilities**:
  - Project CRUD operations
  - Task management
  - Workflow orchestration

### Notification Service
- **Technology**: Node.js
- **Message Queue**: RabbitMQ
- **Responsibilities**:
  - Email notifications
  - Push notifications
  - In-app notifications

## Data Architecture

### Database Design
- **Primary Database**: PostgreSQL 15
- **Read Replicas**: 2 replicas for read scaling
- **Partitioning**: Time-based partitioning for audit logs
- **Indexes**: B-tree indexes on frequently queried columns

### Caching Strategy
- **L1 Cache**: Application-level (in-memory)
- **L2 Cache**: Redis cluster
- **Cache Invalidation**: Event-driven invalidation via message queue
- **TTL**: Configurable per data type (60s - 24h)

### Data Flow
1. Write operations go to primary database
2. Read operations check cache first
3. Cache miss triggers database read and cache update
4. Background jobs sync data to analytics warehouse

## Integration Architecture

### External APIs
- OAuth 2.0 for third-party authentication
- Webhook support for real-time updates
- RESTful APIs with OpenAPI 3.0 specification
- GraphQL gateway for flexible querying

### Message Queue
- **Technology**: RabbitMQ
- **Patterns**: Pub/Sub, Request/Reply, Dead Letter Queue
- **Durability**: Persistent messages with acknowledgments

## Security Architecture

### Authentication
- JWT tokens with RS256 signing
- Refresh token rotation
- Session management with Redis
- Multi-factor authentication support

### Authorization
- Role-based access control (RBAC)
- Attribute-based access control (ABAC) for fine-grained permissions
- API key management for service-to-service communication

### Network Security
- TLS 1.3 for all communications
- VPC isolation for internal services
- WAF protection at edge
- DDoS mitigation

## Deployment Architecture

### Container Orchestration
- **Platform**: Kubernetes (EKS)
- **Container Runtime**: containerd
- **Service Mesh**: Istio

### CI/CD Pipeline
1. Code commit triggers build
2. Unit and integration tests
3. Container image build and scan
4. Deploy to staging
5. E2E tests
6. Manual approval for production
7. Blue-green deployment

### Infrastructure as Code
- Terraform for cloud resources
- Helm charts for Kubernetes deployments
- GitOps workflow with ArgoCD

## Performance & Scalability

### Performance Targets
- API response time: < 200ms (p95)
- Throughput: 10,000 requests/second
- Database query time: < 50ms (p95)

### Scalability Approach
- Horizontal pod autoscaling based on CPU/memory
- Database connection pooling (PgBouncer)
- CDN for static assets
- Regional deployment for latency optimization

### High Availability
- Multi-AZ deployment
- Database failover with RDS Multi-AZ
- Circuit breaker pattern for service calls
- Graceful degradation for non-critical features

## Monitoring & Observability

### Logging
- Centralized logging with ELK stack
- Structured JSON logs
- Log correlation with trace IDs

### Metrics
- Prometheus for metrics collection
- Grafana for visualization
- Custom business metrics dashboards

### Tracing
- Distributed tracing with Jaeger
- Trace sampling at 10%
- End-to-end request tracking

### Alerting
- PagerDuty integration for on-call
- Slack notifications for warnings
- Automated incident response playbooks
`,
	},

	// User Story Golden Reference
	{
		documentType: "USER_STORY",
		name: "User Stories - Feature Set Template",
		description:
			"Golden reference for User Story documents. Contains well-structured user stories with acceptance criteria.",
		requiredSections: ["users", "acceptance"],
		keyPhrases: [
			"As a",
			"I want",
			"so that",
			"acceptance criteria",
			"given",
			"when",
			"then",
			"priority",
			"story points",
			"definition of done",
		],
		projectContext: {
			name: "Feature Development",
			techStack: ["React", "TypeScript", "Node.js"],
			features: ["user-management", "collaboration"],
			projectTypes: ["web", "feature"],
		},
		content: `# User Stories

## User Story Overview

This document contains user stories for the Team Collaboration feature set. Each story follows the standard format with clear acceptance criteria and technical notes for implementation.

**Epic**: Team Collaboration Enhancement
**Sprint**: Sprint 23
**Release Target**: v2.4.0

## User Stories

### US-2301: Team Workspace Creation

**Priority**: P0 (Must Have)
**Story Points**: 8
**Assignee**: TBD

**Story**:
As a team administrator, I want to create dedicated team workspaces so that my team members can collaborate in an organized environment.

**Acceptance Criteria**:

1. **Given** I am logged in as a team admin
   **When** I navigate to the team settings page
   **Then** I see a "Create Workspace" button

2. **Given** I click "Create Workspace"
   **When** the modal opens
   **Then** I can enter a workspace name (required, 3-50 characters)
   **And** I can add an optional description (max 500 characters)
   **And** I can select a workspace template or start blank

3. **Given** I have filled in valid workspace details
   **When** I click "Create"
   **Then** the workspace is created within 3 seconds
   **And** I am redirected to the new workspace
   **And** I see a success notification

4. **Given** workspace creation fails
   **When** an error occurs
   **Then** I see a descriptive error message
   **And** my form inputs are preserved

**Technical Notes**:
- Use optimistic UI update for better UX
- Implement proper error boundary
- Add workspace to search index asynchronously
- Emit workspace.created event for analytics

---

### US-2302: Invite Team Members

**Priority**: P0 (Must Have)
**Story Points**: 5
**Assignee**: TBD

**Story**:
As a workspace owner, I want to invite team members to my workspace so that we can collaborate together.

**Acceptance Criteria**:

1. **Given** I am the workspace owner
   **When** I click "Invite Members"
   **Then** I see an invitation modal

2. **Given** I am in the invitation modal
   **When** I enter valid email addresses (single or comma-separated)
   **Then** each email is validated in real-time
   **And** invalid emails are highlighted with error messages

3. **Given** I select a role for invitees
   **When** I choose from the dropdown
   **Then** I can select: Viewer, Editor, or Admin
   **And** I see a tooltip explaining each role's permissions

4. **Given** I click "Send Invitations"
   **When** all emails are valid
   **Then** invitation emails are sent within 30 seconds
   **And** pending invitations appear in the members list
   **And** I see a confirmation with the number of invitations sent

**Technical Notes**:
- Rate limit: max 50 invitations per hour per workspace
- Email template should include workspace name and inviter name
- Invitation links expire after 7 days
- Support for bulk CSV upload in future iteration

---

### US-2303: Real-time Collaboration Indicator

**Priority**: P1 (Should Have)
**Story Points**: 3
**Assignee**: TBD

**Story**:
As a team member, I want to see who else is currently viewing the same document so that I can avoid conflicting edits.

**Acceptance Criteria**:

1. **Given** I open a document
   **When** other users are viewing the same document
   **Then** I see their avatars in the document header
   **And** the avatars update in real-time (within 2 seconds)

2. **Given** another user joins the document
   **When** they become active
   **Then** their avatar appears with a subtle animation
   **And** I see a tooltip with their name on hover

3. **Given** a user leaves the document
   **When** they navigate away or close the tab
   **Then** their avatar disappears within 5 seconds

4. **Given** more than 5 users are viewing
   **When** I see the avatar group
   **Then** I see 5 avatars plus a "+N more" indicator
   **And** clicking the indicator shows all active users

**Technical Notes**:
- Use WebSocket for presence updates
- Implement debouncing to prevent flickering
- Handle edge cases: browser tab switch, network disconnect
- Consider implementing cursor positions in future iteration

---

### US-2304: Document Version History

**Priority**: P1 (Should Have)
**Story Points**: 5
**Assignee**: TBD

**Story**:
As a document editor, I want to view the version history of a document so that I can track changes and restore previous versions if needed.

**Acceptance Criteria**:

1. **Given** I am viewing a document
   **When** I click "Version History"
   **Then** I see a sidebar with a chronological list of versions

2. **Given** I am in version history view
   **When** I click on a version
   **Then** I see a diff view highlighting changes from the previous version
   **And** additions are shown in green, deletions in red

3. **Given** I am viewing a historical version
   **When** I click "Restore This Version"
   **Then** I see a confirmation dialog
   **And** upon confirmation, the document is updated
   **And** a new version is created (original not deleted)

4. **Given** the document has many versions
   **When** I scroll the version list
   **Then** versions are loaded progressively (pagination)
   **And** I can filter by date range or author

**Technical Notes**:
- Store versions as diffs to minimize storage
- Keep last 100 versions by default
- Archive older versions to cold storage
- Implement efficient diff algorithm (e.g., Myers diff)

---

## Definition of Done

A user story is considered complete when:

- [ ] All acceptance criteria are met and verified
- [ ] Code is reviewed and approved by at least one team member
- [ ] Unit tests cover at least 80% of new code
- [ ] Integration tests pass
- [ ] Documentation is updated (if applicable)
- [ ] No critical or high-severity bugs
- [ ] Feature is deployed to staging and tested
- [ ] Product owner has approved the implementation

## Technical Notes (General)

### API Endpoints Required
- POST /api/workspaces - Create workspace
- POST /api/workspaces/:id/invitations - Send invitations
- GET /api/documents/:id/presence - Get active users
- GET /api/documents/:id/versions - Get version history

### Database Migrations
- Add \`workspaces\` table
- Add \`workspace_invitations\` table
- Add \`document_versions\` table
- Add \`user_presence\` table (or use Redis)

### Feature Flags
- \`team_workspaces_enabled\` - Gate workspace feature
- \`realtime_presence_enabled\` - Gate presence feature
- \`version_history_enabled\` - Gate version history
`,
	},

	// Technical Spec Golden Reference
	{
		documentType: "TECHNICAL_SPEC",
		name: "Technical Spec - Feature Implementation",
		description:
			"Golden reference for Technical Specification documents. Covers implementation details, data models, and API designs.",
		requiredSections: ["summary", "technical", "data", "api", "testing"],
		keyPhrases: [
			"implementation",
			"data model",
			"API",
			"endpoint",
			"schema",
			"migration",
			"testing",
			"unit test",
			"integration test",
			"rollout",
			"feature flag",
			"monitoring",
		],
		projectContext: {
			name: "Feature Implementation",
			techStack: ["TypeScript", "PostgreSQL", "Redis"],
			features: ["api", "data-processing"],
			projectTypes: ["backend", "feature"],
		},
		content: `# Technical Specification: Document Collaboration System

## Overview

This technical specification describes the implementation of a real-time document collaboration system. The system enables multiple users to edit documents simultaneously with conflict resolution, version history, and presence awareness.

### Context

The current document editing system is single-user and requires manual merging of changes. This leads to lost work and user frustration, with support tickets increasing by 40% related to document conflicts.

### Scope

This spec covers:
- Real-time collaborative editing with operational transformation
- Document version history and restoration
- User presence and cursor tracking
- Conflict resolution strategy

## Goals and Non-Goals

### Goals
1. Enable real-time collaborative editing with < 100ms latency
2. Preserve edit history with the ability to restore any version
3. Show real-time presence of active users
4. Handle network disconnections gracefully

### Non-Goals
1. Offline editing support (planned for Phase 2)
2. Rich text formatting (using plain text/markdown for MVP)
3. Comments and suggestions (separate spec)
4. Export to external formats

## Technical Design

### Architecture Overview

\`\`\`
Client Layer:
┌─────────────────┐     ┌─────────────────┐
│   Web Client    │     │  Mobile Client  │
│  (React/CRDT)   │     │   (React Native)│
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │ WebSocket
                     ▼
┌─────────────────────────────────────────┐
│           Collaboration Server          │
│  ┌─────────────┐  ┌─────────────────┐  │
│  │  OT Engine  │  │ Presence Manager│  │
│  └─────────────┘  └─────────────────┘  │
└────────────────────┬────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
    ┌────▼────┐           ┌──────▼──────┐
    │PostgreSQL│           │    Redis    │
    │(Documents)│           │ (Presence) │
    └──────────┘           └─────────────┘
\`\`\`

### Component Details

#### Operational Transformation Engine
- Uses OT algorithm for conflict resolution
- Transforms operations based on causal ordering
- Maintains operation log for undo/redo

#### Presence Manager
- Tracks active users per document
- Updates cursor positions in real-time
- Handles user join/leave events

## Data Model

### Document Schema

\`\`\`sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  workspace_id UUID REFERENCES workspaces(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  version INT DEFAULT 1
);

CREATE INDEX idx_documents_workspace ON documents(workspace_id);
CREATE INDEX idx_documents_updated ON documents(updated_at);
\`\`\`

### Version History Schema

\`\`\`sql
CREATE TABLE document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INT NOT NULL,
  content TEXT NOT NULL,
  diff JSONB, -- Stores diff from previous version
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(document_id, version)
);

CREATE INDEX idx_versions_document ON document_versions(document_id);
\`\`\`

### Operations Log Schema

\`\`\`sql
CREATE TABLE document_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  operation JSONB NOT NULL, -- {type, position, text, ...}
  sequence_num BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_operations_document_seq ON document_operations(document_id, sequence_num);
\`\`\`

## API Design

### REST Endpoints

#### Get Document
\`\`\`
GET /api/documents/:id

Response 200:
{
  "id": "uuid",
  "title": "Document Title",
  "content": "...",
  "version": 42,
  "created_at": "2024-01-15T10:00:00Z",
  "updated_at": "2024-01-15T14:30:00Z"
}
\`\`\`

#### Get Version History
\`\`\`
GET /api/documents/:id/versions?limit=20&offset=0

Response 200:
{
  "versions": [
    {
      "version": 42,
      "created_by": {"id": "uuid", "name": "John"},
      "created_at": "2024-01-15T14:30:00Z",
      "summary": "Added introduction section"
    }
  ],
  "total": 42,
  "has_more": true
}
\`\`\`

#### Restore Version
\`\`\`
POST /api/documents/:id/versions/:version/restore

Response 200:
{
  "id": "uuid",
  "version": 43,
  "content": "..."
}
\`\`\`

### WebSocket Protocol

#### Connection
\`\`\`
WS /api/collaborate/:documentId
Headers: Authorization: Bearer <token>
\`\`\`

#### Messages

**Client → Server: Operation**
\`\`\`json
{
  "type": "operation",
  "operation": {
    "type": "insert",
    "position": 100,
    "text": "Hello"
  },
  "version": 42
}
\`\`\`

**Server → Client: Operation Broadcast**
\`\`\`json
{
  "type": "operation",
  "user_id": "uuid",
  "operation": {...},
  "version": 43
}
\`\`\`

**Server → Client: Presence Update**
\`\`\`json
{
  "type": "presence",
  "users": [
    {"id": "uuid", "name": "John", "cursor": 150}
  ]
}
\`\`\`

## Implementation Plan

### Phase 1: Foundation (Week 1-2)
- [ ] Set up database schemas and migrations
- [ ] Implement basic CRUD API for documents
- [ ] Create WebSocket server infrastructure
- [ ] Unit tests for core functionality

### Phase 2: OT Engine (Week 3-4)
- [ ] Implement OT algorithm
- [ ] Add operation transformation logic
- [ ] Handle concurrent edits
- [ ] Integration tests for OT

### Phase 3: Presence & UI (Week 5-6)
- [ ] Implement presence tracking
- [ ] Build cursor synchronization
- [ ] Frontend integration
- [ ] E2E tests

### Phase 4: History & Polish (Week 7-8)
- [ ] Version history implementation
- [ ] Restore functionality
- [ ] Performance optimization
- [ ] Load testing

## Testing Strategy

### Unit Tests
- OT engine transformation correctness
- Version diff generation
- API input validation

### Integration Tests
- WebSocket connection lifecycle
- Multi-user editing scenarios
- Database transaction integrity

### E2E Tests
- Complete collaboration flow
- Network disconnection recovery
- Browser compatibility

### Performance Tests
- 100 concurrent users per document
- 1000 operations per minute
- < 100ms operation latency

## Rollout Plan

### Phase 1: Internal Testing
- Deploy to staging environment
- Internal team dogfooding for 1 week
- Fix critical issues

### Phase 2: Beta Release
- Enable for 10% of users via feature flag
- Monitor error rates and performance
- Collect user feedback

### Phase 3: General Availability
- Gradual rollout: 25% → 50% → 100%
- Remove feature flag after 2 weeks stable
- Update documentation and help articles

## Monitoring & Alerts

### Key Metrics
- WebSocket connection count
- Operation latency (p50, p95, p99)
- Conflict resolution rate
- Version creation rate

### Alerts
- Connection errors > 1% triggers warning
- Latency p95 > 500ms triggers page
- Database connection pool exhaustion
`,
	},

	// API Spec Golden Reference
	{
		documentType: "API_SPEC",
		name: "API Spec - RESTful Service",
		description:
			"Golden reference for API Specification documents. Covers endpoints, schemas, authentication, and error handling.",
		requiredSections: ["summary", "api", "security"],
		keyPhrases: [
			"endpoint",
			"GET",
			"POST",
			"PUT",
			"DELETE",
			"authentication",
			"authorization",
			"Bearer token",
			"request body",
			"response",
			"status code",
			"error",
			"rate limit",
		],
		projectContext: {
			name: "API Service",
			techStack: ["Node.js", "Express", "PostgreSQL"],
			features: ["rest-api", "authentication"],
			projectTypes: ["backend", "api"],
		},
		content: `# API Specification

## API Overview

This document specifies the RESTful API for the Project Management Platform. The API follows REST conventions and uses JSON for request and response bodies.

### Base URL
\`\`\`
Production: https://api.example.com/v1
Staging: https://api-staging.example.com/v1
\`\`\`

### API Versioning
The API is versioned using URL path versioning. The current version is \`v1\`. When breaking changes are introduced, a new version will be released (e.g., \`v2\`).

## Authentication

### Bearer Token Authentication

All API requests (except authentication endpoints) require a valid Bearer token in the Authorization header.

\`\`\`http
Authorization: Bearer <access_token>
\`\`\`

### Obtaining Tokens

#### POST /auth/login
Authenticate with email and password to receive access and refresh tokens.

**Request Body:**
\`\`\`json
{
  "email": "user@example.com",
  "password": "securepassword"
}
\`\`\`

**Response 200 OK:**
\`\`\`json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2...",
  "token_type": "Bearer",
  "expires_in": 3600
}
\`\`\`

#### POST /auth/refresh
Refresh an expired access token using a valid refresh token.

**Request Body:**
\`\`\`json
{
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2..."
}
\`\`\`

**Response 200 OK:**
\`\`\`json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "expires_in": 3600
}
\`\`\`

## Endpoints

### Projects

#### GET /projects
List all projects accessible to the authenticated user.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| page | integer | No | Page number (default: 1) |
| limit | integer | No | Items per page (default: 20, max: 100) |
| status | string | No | Filter by status: active, archived |
| search | string | No | Search by name or description |

**Response 200 OK:**
\`\`\`json
{
  "data": [
    {
      "id": "proj_123abc",
      "name": "Website Redesign",
      "description": "Complete overhaul of company website",
      "status": "active",
      "created_at": "2024-01-15T10:00:00Z",
      "updated_at": "2024-01-20T14:30:00Z",
      "owner": {
        "id": "user_456def",
        "name": "Jane Smith"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "total_pages": 3
  }
}
\`\`\`

#### POST /projects
Create a new project.

**Request Body:**
\`\`\`json
{
  "name": "New Project",
  "description": "Project description",
  "template_id": "tmpl_789ghi"
}
\`\`\`

**Response 201 Created:**
\`\`\`json
{
  "id": "proj_new123",
  "name": "New Project",
  "description": "Project description",
  "status": "active",
  "created_at": "2024-01-25T09:00:00Z"
}
\`\`\`

#### GET /projects/:id
Get a specific project by ID.

**Response 200 OK:**
\`\`\`json
{
  "id": "proj_123abc",
  "name": "Website Redesign",
  "description": "Complete overhaul of company website",
  "status": "active",
  "settings": {
    "visibility": "team",
    "notifications_enabled": true
  },
  "stats": {
    "total_tasks": 42,
    "completed_tasks": 28,
    "team_members": 5
  },
  "created_at": "2024-01-15T10:00:00Z",
  "updated_at": "2024-01-20T14:30:00Z"
}
\`\`\`

#### PUT /projects/:id
Update a project.

**Request Body:**
\`\`\`json
{
  "name": "Updated Project Name",
  "description": "Updated description",
  "status": "active"
}
\`\`\`

**Response 200 OK:**
Returns the updated project object.

#### DELETE /projects/:id
Delete a project (soft delete).

**Response 204 No Content**

### Tasks

#### GET /projects/:projectId/tasks
List all tasks in a project.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| status | string | No | Filter: todo, in_progress, done |
| assignee | string | No | Filter by assignee user ID |
| priority | string | No | Filter: low, medium, high, urgent |

**Response 200 OK:**
\`\`\`json
{
  "data": [
    {
      "id": "task_abc123",
      "title": "Design homepage mockup",
      "description": "Create initial mockups for the new homepage",
      "status": "in_progress",
      "priority": "high",
      "assignee": {
        "id": "user_456def",
        "name": "Jane Smith"
      },
      "due_date": "2024-02-01T00:00:00Z",
      "created_at": "2024-01-15T10:00:00Z"
    }
  ],
  "pagination": {...}
}
\`\`\`

#### POST /projects/:projectId/tasks
Create a new task.

**Request Body:**
\`\`\`json
{
  "title": "Task title",
  "description": "Task description",
  "priority": "high",
  "assignee_id": "user_456def",
  "due_date": "2024-02-15T00:00:00Z"
}
\`\`\`

**Response 201 Created:**
Returns the created task object.

## Request/Response Schemas

### Common Response Envelope
All successful responses follow this structure:

\`\`\`json
{
  "data": {...},           // Single object or array
  "pagination": {...},     // Only for list endpoints
  "meta": {               // Optional metadata
    "request_id": "req_abc123"
  }
}
\`\`\`

### Pagination Object
\`\`\`json
{
  "page": 1,
  "limit": 20,
  "total": 100,
  "total_pages": 5,
  "has_next": true,
  "has_prev": false
}
\`\`\`

## Error Handling

### Error Response Format
All errors follow a consistent format:

\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request parameters",
    "details": [
      {
        "field": "email",
        "message": "Email is required"
      }
    ],
    "request_id": "req_abc123"
  }
}
\`\`\`

### Error Codes

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 400 | VALIDATION_ERROR | Invalid request parameters |
| 401 | UNAUTHORIZED | Missing or invalid authentication |
| 403 | FORBIDDEN | Insufficient permissions |
| 404 | NOT_FOUND | Resource not found |
| 409 | CONFLICT | Resource conflict (e.g., duplicate) |
| 422 | UNPROCESSABLE_ENTITY | Valid syntax but semantic error |
| 429 | RATE_LIMITED | Too many requests |
| 500 | INTERNAL_ERROR | Server error |

## Rate Limiting

API requests are rate limited to ensure fair usage.

### Rate Limit Headers
\`\`\`http
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1706200800
\`\`\`

### Limits by Plan

| Plan | Requests/Hour | Burst |
|------|---------------|-------|
| Free | 100 | 10/sec |
| Pro | 1,000 | 50/sec |
| Enterprise | 10,000 | 200/sec |

### Rate Limit Exceeded Response
\`\`\`json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Retry after 60 seconds.",
    "retry_after": 60
  }
}
\`\`\`

## Versioning

### Current Version
The current API version is **v1**.

### Deprecation Policy
- Deprecated endpoints will be announced 6 months in advance
- A \`Deprecation\` header will be included in responses
- Migration guides will be provided

### Version Header
You can also specify the API version using a header:
\`\`\`http
X-API-Version: 2024-01-15
\`\`\`

## Webhooks

### Available Events
- \`project.created\`
- \`project.updated\`
- \`project.deleted\`
- \`task.created\`
- \`task.updated\`
- \`task.completed\`

### Webhook Payload
\`\`\`json
{
  "event": "task.completed",
  "timestamp": "2024-01-25T12:00:00Z",
  "data": {
    "id": "task_abc123",
    "project_id": "proj_123abc",
    ...
  }
}
\`\`\`
`,
	},
];

async function seedGoldenReferences() {
	console.log("🌱 Seeding golden references...\n");

	for (const reference of GOLDEN_REFERENCES) {
		try {
			// Check if reference already exists
			const existing = await db.goldenReference.findFirst({
				where: {
					documentType: reference.documentType,
					scope: "SYSTEM",
					name: reference.name,
				},
			});

			if (existing) {
				console.log(
					`  ⏭️  Skipping ${reference.documentType} - "${reference.name}" (already exists)`,
				);
				continue;
			}

			// Create the golden reference
			await db.goldenReference.create({
				data: {
					documentType: reference.documentType,
					name: reference.name,
					description: reference.description,
					content: reference.content,
					projectContext: reference.projectContext,
					requiredSections: reference.requiredSections,
					keyPhrases: reference.keyPhrases,
					scope: "SYSTEM",
					isActive: true,
					version: 1,
				},
			});

			console.log(
				`  ✅ Created ${reference.documentType} - "${reference.name}"`,
			);
		} catch (error) {
			console.error(
				`  ❌ Failed to create ${reference.documentType} - "${reference.name}":`,
				error instanceof Error ? error.message : error,
			);
		}
	}

	console.log("\n✨ Golden reference seeding complete!");
}

// Run if called directly
seedGoldenReferences()
	.catch((error) => {
		console.error("Seed failed:", error);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});

export { seedGoldenReferences, GOLDEN_REFERENCES };
