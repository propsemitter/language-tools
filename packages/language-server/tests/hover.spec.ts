import type { Hover, Position } from '@volar/language-server';
import { formatZedraComponentHover, type ZedraComponentHover } from '@vue/language-service/lib/zedraComponentHover';
import { expect, test } from 'vitest';
import { URI } from 'vscode-uri';
import { getLanguageServer, testWorkspacePath } from './server';

type ComponentHover = Hover & { zedraComponent?: ZedraComponentHover };

async function requestHover(
	server: Awaited<ReturnType<typeof getLanguageServer>>,
	uri: string,
	position: Position,
): Promise<ComponentHover | null> {
	return await server.vueserver.sendHoverRequest(uri, position) as ComponentHover | null;
}

test('component Markdown escapes names and emits valid inline code spans', () => {
	const markdown = formatZedraComponentHover({
		version: 1,
		name: 'Widget',
		description: '',
		props: [{
			name: 'slot_[name](x)',
			type: '`leading and trailing`',
			description: '',
			required: false,
			deprecated: false,
			model: false,
			default: 'value with `fence`',
		}, {
			name: 'multiline',
			type: 'first line\\nsecond line',
			description: '',
			required: false,
			deprecated: false,
			model: false,
		}],
		slots: [],
		events: [],
		exposed: [],
	});

	expect(markdown).toContain('**slot\\_\\[name\\]\\(x\\)**');
	expect(markdown).toContain(': `` `leading and trailing` ``');
	expect(markdown).toContain(' — default: `` value with `fence` ``');
	expect(markdown).toContain('`first line\\nsecond line`');
});

test('negotiated component hover includes structured metadata and preserves markdown', async () => {
	const server = await getLanguageServer({ capability: 1 });
	const content = `<template><HoverChild><!-- </HoverChild> --></HoverChild><hover-child /></template>
<script setup lang="ts">
import HoverChild from './HoverChild.vue';
</script>`;
	const uri = URI.file(`${testWorkspacePath}/tsconfigProject/component-hover.vue`).toString();
	const document = await server.open(uri, 'vue', content);
	const opening = await requestHover(
		server,
		document.uri,
		document.positionAt(content.indexOf('HoverChild')),
	);
	const closing = await requestHover(
		server,
		document.uri,
		document.positionAt(content.lastIndexOf('</HoverChild>') + 3),
	);
	const commentClosing = await requestHover(
		server,
		document.uri,
		document.positionAt(content.indexOf('</HoverChild>') + 3),
	);
	const kebab = await requestHover(
		server,
		document.uri,
		document.positionAt(content.indexOf('hover-child')),
	);
	await server.close(document.uri);

	expect(commentClosing?.zedraComponent).toBeUndefined();
	for (const hover of [opening, closing, kebab]) {
		const component = hover?.zedraComponent;
		expect(component).toMatchObject({ version: 1 });
		if (!component) throw new Error('Expected negotiated component metadata');
		expect(component.props).toContainEqual(expect.objectContaining({
			name: 'label',
			required: true,
			model: true,
			default: '"a`b"',
		}));
		expect(hover.contents).toBeDefined();
		expect(hover.range).toBeDefined();
	}
	const openingComponent = opening?.zedraComponent;
	if (
		!openingComponent
		|| !opening?.contents
		|| typeof opening.contents !== 'object'
		|| Array.isArray(opening.contents)
		|| !('kind' in opening.contents)
	) {
		throw new Error('Expected structured component Markdown hover');
	}
	expect(opening.contents.kind).toBe('markdown');
	expect(openingComponent.name).toBe('HoverChild');
	expect(kebab?.zedraComponent?.name).toBe('hover-child');
	expect(closing?.range?.start).toEqual(document.positionAt(content.lastIndexOf('</HoverChild>') + 2));
	expect(openingComponent.props).toContainEqual(expect.objectContaining({ name: 'oldLabel', deprecated: true }));
	expect(openingComponent.events).toContainEqual(expect.objectContaining({ name: 'change' }));
	expect(openingComponent.slots).toContainEqual(expect.objectContaining({ name: 'default' }));
	expect(openingComponent.exposed).toContainEqual(expect.objectContaining({ name: 'focus' }));
	expect(openingComponent.events.find(event => event.name === 'change')?.type).toContain('value: string');
	expect(opening.contents.value).toContain('"a`b" | "other"');
	expect(opening.contents.value).toContain('``');
});

test('barrel aliases and global components resolve metadata', async () => {
	const server = await getLanguageServer({ capability: 1, rich: true });
	const content = `<template><primary-child /><GlobalHoverChild /></template>
<script setup lang="ts">
import { BarrelChild as primaryChild } from './HoverBarrel';
</script>`;
	const uri = URI.file(`${testWorkspacePath}/tsconfigProject/hover-aliased.vue`).toString();
	const document = await server.open(uri, 'vue', content);
	const aliased = await requestHover(
		server,
		document.uri,
		document.positionAt(content.indexOf('primary-child')),
	);
	const global = await requestHover(
		server,
		document.uri,
		document.positionAt(content.indexOf('GlobalHoverChild')),
	);
	await server.close(document.uri);
	expect(aliased?.zedraComponent?.props).toContainEqual(expect.objectContaining({ name: 'label' }));
	expect(global?.zedraComponent?.props).toContainEqual(expect.objectContaining({ name: 'label' }));
});

test('delayed metadata is discarded when the source document closes', async () => {
	const server = await getLanguageServer({ capability: 1 });
	const content =
		`<template><HoverChild /></template>\n<script setup lang="ts">import HoverChild from './HoverChild.vue';</script>`;
	const uri = URI.file(`${testWorkspacePath}/tsconfigProject/hover-delayed.vue`).toString();
	const document = await server.open(uri, 'vue', content);
	const pause = server.holdNextComponentMeta();
	const pendingHover = requestHover(server, document.uri, document.positionAt(content.indexOf('HoverChild')));
	await pause.started;
	await server.close(document.uri);
	pause.release();
	expect(await pendingHover).toBeNull();
});

test('native, unknown, and non-template matches keep the standard hover response', async () => {
	const server = await getLanguageServer({ capability: 1 });
	const content = `<template><div /><MissingWidget /></template>
<script setup lang="ts">
const sample = '<HoverChild />';
// <HoverChild />
</script>`;
	const uri = URI.file(`${testWorkspacePath}/tsconfigProject/hover-fallback.vue`).toString();
	const document = await server.open(uri, 'vue', content);
	const scriptOffset = content.indexOf('</template>') + '</template>'.length;
	const offsets = [
		content.indexOf('div'),
		content.indexOf('MissingWidget'),
		content.indexOf('HoverChild', scriptOffset),
		content.lastIndexOf('HoverChild'),
	];
	for (const offset of offsets) {
		const hover = await requestHover(server, document.uri, document.positionAt(offset));
		expect(hover?.zedraComponent).toBeUndefined();
	}
	await server.close(document.uri);
});

test.each(
	[
		['unnegotiated', undefined],
		['unsupported version', 2],
	] as const,
)('%s clients receive standard hover only', async (_label, capability) => {
	const server = await getLanguageServer(capability === undefined ? {} : { capability });
	const content =
		`<template><HoverChild /></template>\n<script setup lang="ts">import HoverChild from './HoverChild.vue';</script>`;
	const uri = URI.file(`${testWorkspacePath}/tsconfigProject/hover-client-${_label}.vue`).toString();
	const document = await server.open(uri, 'vue', content);
	const hover = await requestHover(server, document.uri, document.positionAt(content.indexOf('HoverChild')));
	await server.close(document.uri);
	expect(hover?.zedraComponent).toBeUndefined();
	expect(hover?.contents).toBeDefined();
});

test('unnegotiated rich hover uses portable Markdown for opening and closing tags', async () => {
	const server = await getLanguageServer({ rich: true });
	const content =
		`<template><HoverChild></HoverChild></template>\n<script setup lang="ts">import HoverChild from './HoverChild.vue';</script>`;
	const uri = URI.file(`${testWorkspacePath}/tsconfigProject/hover-legacy-rich.vue`).toString();
	const document = await server.open(uri, 'vue', content);
	const opening = await requestHover(server, document.uri, document.positionAt(content.indexOf('HoverChild')));
	const closing = await requestHover(
		server,
		document.uri,
		document.positionAt(content.indexOf('</HoverChild>') + 3),
	);
	await server.close(document.uri);
	for (const hover of [opening, closing]) {
		expect(hover?.zedraComponent).toBeUndefined();
		if (!hover || !hover.contents || typeof hover.contents !== 'object' || Array.isArray(hover.contents)) {
			throw new Error('Expected rich Markdown hover');
		}
		expect(hover.contents.value).toContain('### Props');
		expect(hover.contents.value).not.toContain('<table');
	}
});

test('vue.hover.rich false opts out of negotiated component hover', async () => {
	const server = await getLanguageServer({ capability: 1, rich: false });
	const content =
		`<template><HoverChild /></template>\n<script setup lang="ts">import HoverChild from './HoverChild.vue';</script>`;
	const uri = URI.file(`${testWorkspacePath}/tsconfigProject/hover-disabled.vue`).toString();
	const document = await server.open(uri, 'vue', content);
	const hover = await requestHover(server, document.uri, document.positionAt(content.indexOf('HoverChild')));
	await server.close(document.uri);
	expect(hover?.zedraComponent).toBeUndefined();
	expect(hover?.contents).toBeDefined();
});

test('global at leading code is not cut', async () => {
	const content = `<template>
	{{Math.max(foo)}}
</template>

<script setup lang="ts">
const foo = 1;
</script>`;
	const offset = content.indexOf('Math');

	const server = await getLanguageServer();
	const document = await server.open(
		URI.file(`${testWorkspacePath}/tsconfigProject/fixture.vue`).toString(),
		'vue',
		content,
	);

	const res = await server.tsserver.message({
		seq: server.nextSeq(),
		command: 'quickinfo',
		arguments: {
			file: URI.parse(document.uri).fsPath,
			position: offset,
		},
	});

	await server.close(document.uri);

	expect(res.success).toBe(true);
	expect(res.body?.displayString).toBe('var Math: Math');
});
