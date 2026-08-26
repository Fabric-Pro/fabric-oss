# /improve-skills - Skill Enhancement Workflow

> **Usage**: Copy this prompt or reference it with `@.cursor/prompts/improve-skills.md`

---

## Workflow Instructions

I want you to help me improve the files that make up your Skills by rewriting their descriptions so that they can be more readily discovered and used when working on coding tasks.

All of the Skills in our project are located in `.cursor/skills/`. Each Skill has its own folder and inside each Skill folder is a file called `SKILL.md`.

## Using the skill-creator Skill

**IMPORTANT**: Use the `skill-creator` skill (`@.cursor/skills/skill-creator/SKILL.md`) to improve each SKILL.md file. The skill-creator provides templates, best practices, and patterns for creating high-quality skills.

LOOP through each `SKILL.md` file and FOR EACH use the following process to revise its content and improve it:

---

## Skill Improvement Process

### Step 1: Confirm Which Skills to Improve

First, ask the user to confirm whether they want ALL of their skills to be improved, or only select Skills. Display the following message, then WAIT for the user's response:

```
Before I proceed with improving your Skills, can you confirm that you want me to revise and improve ALL Skills in your .cursor/skills/ folder?

If not, please specify which Skills I should include or exclude.
```

### Step 2: Analyze What This Skill Does

**Use the skill-creator skill** to analyze and understand each skill file.

Analyze and read the skill file to understand:
- What it is
- What it should be used for
- When it should be used

Look to these places to read and understand each skill:
- The Skill's name and file name
- The SKILL.md content and any linked standards files
- Use skill-creator's templates to guide improvements

### Step 3: Rewrite the Skill Description

**Use the skill-creator skill** to rewrite the description following best practices.

The most important element of a SKILL.md file that impacts its discoverability and trigger-ability is the content in the `description` in the frontmatter.

Rewrite this description using the following guidelines:

- The first sentence should clearly describe what this skill is
  - Example: "Write Tailwind CSS code and structure front-end UIs using Tailwind CSS utility classes."
- Subsequent sentences should describe examples of when this skill should be used
- Include "When writing or editing [file types]" where applicable
- Include situations, areas, or tools where this skill applies
- The description text can be long - there is no maximum limit
- Focus on when the skill SHOULD be used (not when NOT to use it)

### Step 4: Insert a Section for 'When to Use This Skill'

At the top of the content of SKILL.md, below the frontmatter, insert an H2 heading:

```markdown
## When to use this skill

- [Descriptive example A]
- [Descriptive example B]
- [Descriptive example C]
...
```

### Step 5: Advise the User on Further Improvements

After revising ALL SKILL.md files, display:

```
✅ All Skills have been analyzed and revised using the skill-creator skill!

RECOMMENDATIONS 👉 Review and revise them further using these tips:

- Make Skills as descriptive as possible
- Use their 'description' frontmatter to describe when this skill should proactively be used
- Include all relevant instructions, details and directives within the content of the Skill
- You can link to other files (like your Fabric standards files) using markdown links
- You can consolidate multiple similar skills into single skills where it makes sense

💡 The skill-creator skill was used to ensure proper structure, clear activation criteria, and effective patterns.
```

---

## Start Now

Ask me: **"Which skills should I improve?"** and list available skills in `.cursor/skills/`

