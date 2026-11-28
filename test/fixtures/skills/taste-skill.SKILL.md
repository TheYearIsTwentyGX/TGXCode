---
name: design-taste-frontend
description: >-
  tasteskill 2.5.1, the anti-slop frontend skill. Builds professional company websites at the level
  of figma.com and x.ai: plain copy in a voice of its own, one system, one section per screen,
  equal edges, real photographs and real product UI (licensed stand-in photographs when the client
  has none; a product render only when the brief asks for 3D), a hero entrance and one or two dealt
  moments on every page, shader effects and scenes only on tech, gaming and software pages, quiet
  micro-interactions, and a checker and finish gate that enforce it in a real browser. Use this
  whenever you build, design, redesign, restyle, polish or review a landing page, company,
  product, shop, cafe, hotel, studio, SaaS, AI, developer-tool or game site, as static HTML/CSS or
  inside an existing React, Next.js, Vue, Svelte, Astro or Tailwind project, or when the user says
  a page looks generic, templated or "AI-made".
hooks:
  Stop:
    - hooks:
        - type: command
          command: 'for f in ${CLAUDE_SKILL_DIR:+"$CLAUDE_SKILL_DIR/scripts/gate.mjs"} ${CLAUDE_PLUGIN_ROOT:+"$CLAUDE_PLUGIN_ROOT/scripts/gate.mjs" "$CLAUDE_PLUGIN_ROOT/skills/taste-skill/scripts/gate.mjs"} ${CLAUDE_PROJECT_DIR:+"$CLAUDE_PROJECT_DIR/.claude/skills/design-taste-frontend/scripts/gate.mjs" "$CLAUDE_PROJECT_DIR/.agents/skills/design-taste-frontend/scripts/gate.mjs"} ${HOME:+"$HOME/.claude/skills/design-taste-frontend/scripts/gate.mjs" "$HOME/.agents/skills/design-taste-frontend/scripts/gate.mjs"}; do if [ -f "$f" ]; then exec node "$f" --hook claude; fi; done; if [ -d .taste-skill ]; then printf "%s gate.mjs not found; CLAUDE_PLUGIN_ROOT=%s CLAUDE_PROJECT_DIR=%s HOME=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CLAUDE_PLUGIN_ROOT-}" "${CLAUDE_PROJECT_DIR-}" "${HOME-}" > .taste-skill/gate-hook-missing.txt 2>/dev/null; fi; for d in .taste-skill */.taste-skill; do if [ -f "$d/build.json" ]; then echo "tasteskill gate: gate.mjs not found (CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT-}); the build in $d is not checked" >&2; break; fi; done; exit 0'
          timeout: 600
---

# tasteskill 2.5

(Frontmatter of leonxlnx/taste-skill skills/taste-skill/SKILL.md, captured 2026-11-28; body cut. MIT licence, copyright (c) 2026 Leonxlnx.)
