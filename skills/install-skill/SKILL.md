---
name: install-skill
description: Search and install skills from skills.sh and GitHub repos. Use when users ask to find skills, install skills, download skills, add skills from GitHub, search for skills, browse skills, get a skill, or want new capabilities. Trigger phrases include "install skill", "find skill", "search skills", "add skill", "download skill", "get skill from github", "skills.sh", "browse skills", "what skills are available", "I need a skill for".
---

# Install Skill

Search for skills on skills.sh and install them into the project's `skills/` directory. Always project level.

## Scripts

Two scripts are provided in this skill's directory:

### Search: `search.mjs`

```bash
node ${SKILL_DIR}/search.mjs "<query>"
```

Returns JSON array of matching skills:
```json
[{"source": "owner/repo", "id": "skill-name", "name": "skill-name", "installs": 1234}]
```

### Install: `install.mjs`

```bash
node ${SKILL_DIR}/install.mjs <owner/repo> <skill-name> <project-skills-dir>
```

Downloads all skill files from the GitHub repo into `<project-skills-dir>/<skill-name>/`. Returns:
```json
{"ok": true, "skill": "name", "source": "owner/repo", "path": "/full/path", "files": ["SKILL.md", ...]}
```

## Workflow

1. If the user gives a specific repo and skill name, skip to step 3.

2. **Search**: Run `search.mjs` with the user's query. Show the top results as a numbered list with name, repo, and install count. Ask which one they want.

3. **Install**: Run `install.mjs` with the chosen repo, skill name, and the project's `skills/` directory path.

4. **Confirm**: Show what was installed — skill name, source, files downloaded, and path.

Replace `${SKILL_DIR}` with the actual path to this skill's directory when running the scripts.
