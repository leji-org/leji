# Example: monorepo context layer at `indexed` conformance

A minimal, complete Leji context layer in a single repository: manifest, boot profile, two content categories plus decision memory, generated index, machine changelog, and agent profiles bound through the manifest agents map.

What to notice:

- `leji.json` maps only the categories that exist, with no empty directories to satisfy a checklist.
- There are intentionally no vendor files: agents enter by direct invocation of the boot profile (`claude "Read ./docs/boot-profile.md and follow it."`). The fallback wiring, for repositories that need it, is shown in the multi-repo example and the adoption guide.
- The changelog's first entry was proposed by an agent and approved by a person: the circle in practice.
