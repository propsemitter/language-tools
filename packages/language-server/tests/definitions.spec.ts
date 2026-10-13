import type { TextDocument } from '@volar/language-server';
import { afterEach, describe, expect, test } from 'vitest';
import { URI } from 'vscode-uri';
import { getLanguageServer, testWorkspacePath } from './server';

test('TS to vue', async () => {
	expect(
		await requestDefinition('tsconfigProject/fixture1.ts', 'typescript', `import C|omponent from './empty.vue';`),
	).toMatchInlineSnapshot(`
		[
		  {
		    "end": {
		      "line": 1,
		      "offset": 1,
		    },
		    "file": "\${testWorkspacePath}/tsconfigProject/empty.vue",
		    "start": {
		      "line": 1,
		      "offset": 1,
		    },
		  },
		]
	`);
	expect(
		await requestDefinition('tsconfigProject/fixture2.ts', 'typescript', `import Component from '|./empty.vue';`),
	).toMatchInlineSnapshot(`
		[
		  {
		    "end": {
		      "line": 1,
		      "offset": 1,
		    },
		    "file": "\${testWorkspacePath}/tsconfigProject/empty.vue",
		    "start": {
		      "line": 1,
		      "offset": 1,
		    },
		  },
		]
	`);
});

test('Alias path', async () => {
	await prepareDocument('tsconfigProject/foo.ts', 'typescript', `export const foo = 'foo';`);
	expect(
		await requestDefinition(
			'tsconfigProject/fixture.vue',
			'vue',
			`
			<script setup lang="ts">
			import { foo| } from '@/foo';
			</script>
		`,
		),
	).toMatchInlineSnapshot(`
		[
		  {
		    "contextEnd": {
		      "line": 1,
		      "offset": 26,
		    },
		    "contextStart": {
		      "line": 1,
		      "offset": 1,
		    },
		    "end": {
		      "line": 1,
		      "offset": 17,
		    },
		    "file": "\${testWorkspacePath}/tsconfigProject/foo.ts",
		    "start": {
		      "line": 1,
		      "offset": 14,
		    },
		  },
		]
	`);
});

test('#2600', async () => {
	await prepareDocument(
		'tsconfigProject/foo.vue',
		'vue',
		`
		<template>
			<h1>{{ msg }}</h1>
		</template>

		<script lang="ts">
		export default defineProps<{ msg: string }>()
		</script>
	`,
	);
	expect(
		await requestDefinition(
			'tsconfigProject/fixture.vue',
			'vue',
			`
			<script setup lang="ts">
			import Foo from '|@/foo.vue';
			</script>
		`,
		),
	).toMatchInlineSnapshot(`
		[
		  {
		    "end": {
		      "line": 8,
		      "offset": 3,
		    },
		    "file": "\${testWorkspacePath}/tsconfigProject/foo.vue",
		    "start": {
		      "line": 7,
		      "offset": 3,
		    },
		  },
		]
	`);
});

describe('Template component definitions through named and re-exported imports', () => {
	const cases = [
		{
			name: 'named import, PascalCase opening tag',
			content:
				`<script setup lang="ts">\nimport { ActionButton } from './barrel';\n</script>\n<template><Action|Button></ActionButton></template>`,
			file: 'NamedButton.vue',
			importedName: 'ActionButton',
		},
		{
			name: 'named import, PascalCase closing tag',
			content:
				`<script setup lang="ts">\nimport { ActionButton } from './barrel';\n</script>\n<template><ActionButton></Action|Button></template>`,
			file: 'NamedButton.vue',
			importedName: 'ActionButton',
		},
		{
			name: 'aliased named import, kebab-case opening tag',
			content:
				`<script setup lang="ts">\nimport { ActionButton as PrimaryButton } from './barrel';\n</script>\n<template><primary-|button></primary-button></template>`,
			file: 'NamedButton.vue',
			importedName: 'PrimaryButton',
		},
		{
			name: 'nested re-export, PascalCase opening tag',
			content:
				`<script setup lang="ts">\nimport { NestedButton } from './nested-barrel';\n</script>\n<template><Nested|Button></NestedButton></template>`,
			file: 'NamedButton.vue',
			importedName: 'NestedButton',
		},
		{
			name: 'nested re-export, kebab-case closing tag',
			content:
				`<script setup lang="ts">\nimport { NestedButton } from './nested-barrel';\n</script>\n<template><nested-button></nested-|button></template>`,
			file: 'NamedButton.vue',
			importedName: 'NestedButton',
		},
	];

	for (const definitionCase of cases) {
		test(definitionCase.name, async () => {
			await prepareDocument('tsconfigProject/NamedButton.vue', 'vue', '<template><button /></template>');
			await prepareDocument(
				'tsconfigProject/barrel.ts',
				'typescript',
				"export { default as ActionButton } from './NamedButton.vue';",
			);
			await prepareDocument(
				'tsconfigProject/nested-barrel.ts',
				'typescript',
				"export { ActionButton as NestedButton } from './barrel';",
			);
			const importedSymbolDefinition = await requestDefinition(
				'tsconfigProject/fixture.vue',
				'vue',
				definitionCase.content.replace('|', '').replace(definitionCase.importedName, `|${definitionCase.importedName}`),
				'definitionAndBoundSpan',
			);
			expect(importedSymbolDefinition.map(definition => definition.file), JSON.stringify(importedSymbolDefinition))
				.toContain(
					'${testWorkspacePath}/tsconfigProject/' + definitionCase.file,
				);
			const definitions = await requestDefinition(
				'tsconfigProject/fixture.vue',
				'vue',
				definitionCase.content,
				'definitionAndBoundSpan',
			);
			expect(definitions.map(definition => definition.file)).toContain(
				'${testWorkspacePath}/tsconfigProject/' + definitionCase.file,
			);
		});
	}
});

const openedDocuments: TextDocument[] = [];

afterEach(async () => {
	const server = await getLanguageServer();
	for (const document of openedDocuments) {
		await server.close(document.uri);
	}
	openedDocuments.length = 0;
});

async function requestDefinition(
	fileName: string,
	languageId: string,
	content: string,
	command: 'definition' | 'definitionAndBoundSpan' = 'definition',
) {
	const offset = content.indexOf('|');
	expect(offset).toBeGreaterThanOrEqual(0);
	content = content.slice(0, offset) + content.slice(offset + 1);

	const server = await getLanguageServer();
	let document = await prepareDocument(fileName, languageId, content);

	const res = await server.tsserver.message({
		seq: server.nextSeq(),
		command,
		arguments: {
			file: URI.parse(document.uri).fsPath,
			...(command === 'definitionAndBoundSpan'
				? {
					line: content.slice(0, offset).split('\n').length,
					offset: (content.slice(0, offset).split('\n').at(-1)?.length ?? 0) + 1,
				}
				: { position: offset }),
		},
	});
	expect(res.success).toBe(true);

	const definitions = command === 'definitionAndBoundSpan' ? res.body?.definitions ?? [] : res.body;
	for (const ref of definitions) {
		ref.file = '${testWorkspacePath}' + ref.file.slice(testWorkspacePath.length);
	}

	return definitions;
}

async function prepareDocument(fileName: string, languageId: string, content: string) {
	const server = await getLanguageServer();
	const uri = URI.file(`${testWorkspacePath}/${fileName}`);
	const document = await server.open(uri.toString(), languageId, content);
	if (openedDocuments.every(d => d.uri !== document.uri)) {
		openedDocuments.push(document);
	}
	return document;
}
