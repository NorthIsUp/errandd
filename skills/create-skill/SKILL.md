---
name: create-skill
description: Create new skills for Claude Code. Use when users ask to create a skill, add a skill, make a new command, build a skill, add a slash command, create a plugin skill, or define a new automation. Trigger phrases include "create a skill", "new skill", "add a skill", "make a command", "build a skill", "I want a skill that", "add slash command", "create automation".
---

# Create Skill

Create new skills for Claude Code. Use `$ARGUMENTS` to determine what the user wants.

## Skill File Format

A skill is a `SKILL.md` file inside a `skills/<skill-name>/` directory. It uses YAML frontmatter:

```markdown
---
name: my-skill
description: Short description of when to trigger this skill. Include trigger phrases so Claude knows when to activate it.
---

# Skill Title

Instructions for what Claude should do when this skill is triggered.
```

### Key rules for SKILL.md:
- **name**: lowercase, kebab-case (e.g. `my-skill`)
- **description**: must include trigger phrases and keywords so Claude knows when to use it
- The body contains the full instructions Claude will follow when the skill is invoked

## Scope

Skills can be created at two levels:

### Project Level (default)
- Location: `<project-root>/skills/<skill-name>/SKILL.md`
- Only available within this project
- No special permissions needed
- Use this when the skill is project-specific

### Global Level
- Location: `~/.claude/skills/<skill-name>/SKILL.md`
- Available across all projects
- Requires write access to `~/.claude/`
- Use this when the skill should work everywhere

## Steps

1. Ask the user conversationally what the skill should do, what scope (project or global), and what name they want. Suggest ideas based on context.

2. Based on their answers, generate the `SKILL.md` content:
   - Write a clear, descriptive `name` in kebab-case
   - Write a `description` with plenty of trigger phrases so Claude knows when to activate it
   - Write detailed body instructions for what Claude should do

3. Create the skill:
   - **Project level**: Write to `skills/<skill-name>/SKILL.md` relative to project root
   - **Global level**: Write to `~/.claude/skills/<skill-name>/SKILL.md`

4. Confirm creation and show the user:
   - The skill name and path
   - How to invoke it: `/<plugin-name>:<skill-name>` or just by asking naturally (Claude auto-triggers based on description)
   - Remind them the skill is available immediately — no restart needed
