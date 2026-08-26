import type { LucideIcon } from "lucide-react";
import {
	ArrowLeftRight,
	Boxes,
	Brain,
	Code,
	Database,
	GitBranch,
} from "lucide-react";

/**
 * Mermaid diagram template constants.
 * Each template is valid Mermaid syntax with inline comments to guide users.
 */

const FLOWCHART_TEMPLATE = `flowchart TD
    %% Define your nodes and connections
    Start([Start]) --> Decision{Decision?}
    Decision -->|Yes| Process[Process A]
    Decision -->|No| AltProcess[Process B]
    Process --> End([End])
    AltProcess --> End`;

const SEQUENCE_DIAGRAM_TEMPLATE = `sequenceDiagram
    %% Define participants and their interactions
    actor User
    participant API as API Server
    participant DB as Database

    User->>API: Send request
    activate API
    API->>DB: Query data
    activate DB
    DB-->>API: Return results
    deactivate DB
    API-->>User: Send response
    deactivate API`;

const CLASS_DIAGRAM_TEMPLATE = `classDiagram
    %% Define classes and their relationships
    class Animal {
        +String name
        +int age
        +makeSound() void
    }
    class Dog {
        +String breed
        +fetch() void
    }
    class Cat {
        +bool isIndoor
        +purr() void
    }

    Animal <|-- Dog : extends
    Animal <|-- Cat : extends`;

const ER_DIAGRAM_TEMPLATE = `erDiagram
    %% Define entities and their relationships
    USER {
        string id PK
        string name
        string email
    }
    POST {
        string id PK
        string title
        string content
        string authorId FK
    }

    USER ||--o{ POST : writes`;

const MINDMAP_TEMPLATE = `mindmap
    root((Central Topic))
        Branch A
            Leaf A1
            Leaf A2
        Branch B
            Leaf B1
            Leaf B2
        Branch C
            Leaf C1`;

/**
 * Metadata for a Mermaid diagram template, used by slash commands and the toolbar dropdown.
 */
export interface DiagramTemplate {
	/** Unique identifier for the diagram type */
	id: string;
	/** Human-readable title */
	title: string;
	/** Short description for the UI */
	description: string;
	/** Lucide icon component */
	icon: LucideIcon;
	/** The Mermaid template string */
	template: string;
	/** Slash command trigger (without leading slash) */
	command: string;
}

export const DIAGRAM_TEMPLATES: DiagramTemplate[] = [
	{
		id: "empty",
		title: "Empty Diagram",
		description: "Blank mermaid block — write your own",
		icon: Code,
		template: "graph TD\n    %% Start typing your diagram here",
		command: "diagram",
	},
	{
		id: "flowchart",
		title: "Flowchart",
		description: "Process flow with decisions and steps",
		icon: GitBranch,
		template: FLOWCHART_TEMPLATE,
		command: "flowchart",
	},
	{
		id: "sequence-diagram",
		title: "Sequence Diagram",
		description: "Interactions between actors over time",
		icon: ArrowLeftRight,
		template: SEQUENCE_DIAGRAM_TEMPLATE,
		command: "sequence-diagram",
	},
	{
		id: "class-diagram",
		title: "Class Diagram",
		description: "Object-oriented class relationships",
		icon: Boxes,
		template: CLASS_DIAGRAM_TEMPLATE,
		command: "class-diagram",
	},
	{
		id: "er-diagram",
		title: "ER Diagram",
		description: "Entity relationships for databases",
		icon: Database,
		template: ER_DIAGRAM_TEMPLATE,
		command: "er-diagram",
	},
	{
		id: "mindmap",
		title: "Mindmap",
		description: "Hierarchical topic visualization",
		icon: Brain,
		template: MINDMAP_TEMPLATE,
		command: "mindmap",
	},
	// C4 diagrams (C4Context, C4Container) removed — they use HTML-based
	// rendering via <foreignObject> which cannot be exported to PDF/DOCX.
	// Users can still type C4 syntax manually in a mermaid block if needed
	// for web-only viewing.
];
