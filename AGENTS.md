# johniexu.github.io

This repository is a personal blog built with Astro 5 and the `astro-pure` theme. It deploys from the `next` branch through GitHub Actions.

## Commands

Use Bun for local commands unless a task specifically requires another tool:

```bash
bun install
bun dev
bun run build
bun run check
bun run lint
bun run format
bun run sync
```

Important notes:

- `bun run build` runs `astro-pure check`, `astro check`, and `astro build`.
- Run `bun run build` after adding or changing public content.
- Run `bun run check` for focused Astro type/content collection validation.
- `bun run lint` and `bun run format` may modify files.

## Cursor Cloud Environment

- Cursor Cloud uses `.cursor/environment.json` and `.cursor/Dockerfile` to install Bun before agent sessions start.
- The Cloud install step runs `bun install --frozen-lockfile` so dependency installs can be cached between agent runs.
- If the lockfile changes, run `bun install` locally and commit the updated `bun.lock`.

## Project Structure

- `src/content/blog/`: blog posts in Markdown or MDX.
- `src/content/docs/`: docs content in Markdown or MDX.
- `src/content.config.ts`: content collection schemas.
- `src/pages/`: Astro routes.
- `src/layouts/`: shared page and content layouts.
- `src/components/`: Astro components for home, about, links, projects, and shared head content.
- `src/site.config.ts`: site metadata, menu, footer, and integrations.
- `uno.config.ts`: UnoCSS and typography customization.

## Content Guidelines

- Prefer Chinese for blog posts unless the post topic requires another language.
- New blog posts should usually live at `src/content/blog/<slug>/index.md`.
- Keep frontmatter aligned with `src/content.config.ts`.
- Use concise `description` values because they are used in listing and SEO metadata.
- Set `draft: false` only when the article is ready to publish.
- Set `language: 'zh'` for Chinese posts.

## Change Guidelines

- Keep edits scoped to the requested content, component, or page.
- Do not manually edit generated directories such as `dist/`, `.astro/`, `.vercel/`, or dependency folders.
- Follow existing Astro component and Markdown article style before introducing new patterns.
- For UI changes, verify the rendered page in a browser when possible and include a screenshot or recording.

## Deployment

- Base branch: `next`.
- GitHub Actions workflow: `.github/workflows/deploy.yml`.
- Production build command: `bun run build`.
- Build output directory: `dist/`.
