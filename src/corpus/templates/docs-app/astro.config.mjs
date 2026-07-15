// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

// A docs-app is served at the entity ROOT (e.g. https://my-docs--<grid>.cloudgrid.io/),
// so there is NO `base`. (A base is only needed when a docs site is mounted under
// a sub-path like /docs — that is a special case, not the default.)
// https://astro.build/config
export default defineConfig({
	site: 'https://example.com',
	integrations: [
		starlight({
			// Emit agent-readable docs on every build: /llms.txt (index) and
			// /llms-full.txt (full content). Keeps in sync with the content.
			plugins: [
				starlightLlmsTxt({
					projectName: 'My Project',
					description: 'One-line summary of what this project is — shown to agents at /llms.txt.',
				}),
			],
			title: 'My Project Docs',
			description: 'Documentation for My Project.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/your-org/your-repo' },
			],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Introduction', slug: 'index' },
						{ label: 'Getting started', slug: 'guides/getting-started' },
					],
				},
				{
					label: 'Reference',
					items: [{ label: 'Overview', slug: 'reference/overview' }],
				},
			],
		}),
	],
});
