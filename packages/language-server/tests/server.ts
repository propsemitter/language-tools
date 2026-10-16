import { launchServer } from '@typescript/server-harness';
import { ConfigurationRequest, PublishDiagnosticsNotification, type TextDocument } from '@volar/language-server';
import type { LanguageServerHandle } from '@volar/test-utils';
import { startLanguageServer } from '@volar/test-utils';
import * as path from 'node:path';
import { URI } from 'vscode-uri';

type TestServer = {
	vueserver: LanguageServerHandle;
	tsserver: import('@typescript/server-harness').Server;
	nextSeq: () => number;
	holdNextComponentMeta: () => { started: Promise<void>; release: () => void };
	open: (uri: string, languageId: string, content: string) => Promise<TextDocument>;
	close: (uri: string) => Promise<void>;
};

const servers = new Map<string, Promise<TestServer>>();
let seq = 1;

export const testWorkspacePath = path.resolve(__dirname, '../../../test-workspace');

export function getLanguageServer(options: { capability?: number; rich?: boolean } = {}): Promise<TestServer> {
	const key = `${options.capability ?? 'none'}:${options.rich ?? 'unset'}`;
	let server = servers.get(key);
	if (!server) {
		server = startTestServer(options);
		servers.set(key, server);
	}
	return server;
}

async function startTestServer(options: { capability?: number; rich?: boolean }): Promise<TestServer> {
	const tsserver = launchServer(
		require.resolve('typescript/lib/tsserver', {
			paths: [path.dirname(require.resolve('typescript/package.json'))],
		}),
		[
			'--disableAutomaticTypingAcquisition',
			'--globalPlugins',
			'@vue/typescript-plugin',
			'--pluginProbeLocations',
			path.join(__dirname, '..'),
			'--suppressDiagnosticEvents',
		],
	);
	const vueserver = startLanguageServer(require.resolve('../index.js'), testWorkspacePath);
	let nextComponentMetaPause: { started: () => void; released: Promise<void> } | undefined;
	vueserver.connection.onNotification(PublishDiagnosticsNotification.type, () => {});
	vueserver.connection.onRequest(ConfigurationRequest.type, ({ items }) => {
		return items.map(({ section }) => {
			if (section?.startsWith('vue.inlayHints.')) return true;
			if (section === 'vue.hover.rich') return options.rich ?? null;
			return null;
		});
	});
	vueserver.connection.onNotification('tsserver/request', async ([id, command, args]) => {
		if (command === '_vue:getComponentMeta' && nextComponentMetaPause) {
			const pause = nextComponentMetaPause;
			nextComponentMetaPause = undefined;
			pause.started();
			await pause.released;
		}
		tsserver.message({ seq: seq++, command, arguments: args }).then(
			res => vueserver.connection.sendNotification('tsserver/response', [id, res?.body]),
			() => vueserver.connection.sendNotification('tsserver/response', [id, undefined]),
		);
	});
	await vueserver.initialize(
		URI.file(testWorkspacePath).toString(),
		{},
		{
			workspace: { configuration: true },
			...(options.capability === undefined
				? {}
				: { experimental: { zedraComponentHover: { version: options.capability } } }),
		},
	);
	return {
		vueserver,
		tsserver,
		nextSeq: () => seq++,
		holdNextComponentMeta: () => {
			let started!: () => void;
			let release!: () => void;
			const startedPromise = new Promise<void>(resolve => started = resolve);
			const released = new Promise<void>(resolve => release = resolve);
			nextComponentMetaPause = { started, released };
			return { started: startedPromise, release };
		},
		open: async (uri, languageId, content) => {
			if (uri.startsWith('file://')) {
				const res = await tsserver.message({
					seq: seq++,
					type: 'request',
					command: 'updateOpen',
					arguments: {
						changedFiles: [],
						closedFiles: [],
						openFiles: [{ file: URI.parse(uri).fsPath, fileContent: content }],
					},
				});
				if (!res.success) throw new Error(res.body);
			}
			return await vueserver.openInMemoryDocument(uri, languageId, content);
		},
		close: async uri => {
			if (uri.startsWith('file://')) {
				const res = await tsserver.message({
					seq: seq++,
					type: 'request',
					command: 'updateOpen',
					arguments: { changedFiles: [], closedFiles: [URI.parse(uri).fsPath], openFiles: [] },
				});
				if (!res.success) throw new Error(res.body);
			}
			await vueserver.closeTextDocument(uri);
		},
	};
}
