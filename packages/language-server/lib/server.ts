import type { LanguageServer } from '@volar/language-server';
import { createLanguageServiceEnvironment } from '@volar/language-server/lib/project/simpleProject';
import { createConnection, createServer } from '@volar/language-server/node';
import {
	createLanguage,
	createParsedCommandLine,
	createParsedCommandLineByJson,
	createVueLanguagePlugin,
	findComponentTagAtOffset,
	type VueVirtualCode,
} from '@vue/language-core';
import {
	createLanguageService,
	createUriMap,
	createVueLanguageServicePlugins,
	type LanguageService,
} from '@vue/language-service';
import {
	createZedraComponentHover,
	formatZedraComponentHover,
	type ZedraComponentMeta,
} from '@vue/language-service/lib/zedraComponentHover';
import type * as ts from 'typescript';
import { URI } from 'vscode-uri';

export function startServer(ts: typeof import('typescript')) {
	const connection = createConnection();
	const server = createServer(connection);
	const tsserverRequestHandlers = new Map<number, (res: any) => void>();

	let tsserverRequestId = 0;

	connection.listen();

	connection.onNotification('tsserver/response', ([id, res]) => {
		tsserverRequestHandlers.get(id)?.(res);
		tsserverRequestHandlers.delete(id);
	});

	connection.onInitialize(params => {
		const tsconfigProjects = createUriMap<LanguageService>();
		const experimentalCapabilities = params.capabilities.experimental as {
			zedraComponentHover?: { version?: unknown };
		} | undefined;
		const componentHoverVersion = experimentalCapabilities?.zedraComponentHover?.version === 1 ? 1 : undefined;
		const file2ProjectInfo = new Map<string, Promise<ts.server.protocol.ProjectInfo | null>>();

		server.fileWatcher.onDidChangeWatchedFiles(({ changes }) => {
			for (const change of changes) {
				const changeUri = URI.parse(change.uri);
				if (tsconfigProjects.has(changeUri)) {
					tsconfigProjects.get(changeUri)!.dispose();
					tsconfigProjects.delete(changeUri);
					file2ProjectInfo.clear();
				}
			}
		});

		let simpleLanguageService: LanguageService | undefined;

		const result = server.initialize(
			params,
			{
				setup() {},
				async getLanguageService(uri) {
					if (uri.scheme === 'file') {
						const fileName = uri.fsPath.replace(/\\/g, '/');
						let projectInfoPromise = file2ProjectInfo.get(fileName);
						if (!projectInfoPromise) {
							projectInfoPromise = sendTsServerRequest<ts.server.protocol.ProjectInfo>(
								'_vue:' + ts.server.protocol.CommandTypes.ProjectInfo,
								{
									file: fileName,
									needFileNameList: false,
								} satisfies ts.server.protocol.ProjectInfoRequestArgs,
							);
							file2ProjectInfo.set(fileName, projectInfoPromise);
						}
						const projectInfo = await projectInfoPromise;
						if (projectInfo) {
							const { configFileName } = projectInfo;
							let languageService = tsconfigProjects.get(URI.file(configFileName));
							if (!languageService) {
								languageService = createProjectLanguageService(server, configFileName);
								tsconfigProjects.set(URI.file(configFileName), languageService);
							}
							return languageService;
						}
					}
					return simpleLanguageService ??= createProjectLanguageService(server, undefined);
				},
				getExistingLanguageServices() {
					const projects = [...tsconfigProjects.values()];
					if (simpleLanguageService) {
						projects.push(simpleLanguageService);
					}
					return projects;
				},
				reload() {
					for (const languageService of tsconfigProjects.values()) {
						languageService.dispose();
					}
					tsconfigProjects.clear();
					if (simpleLanguageService) {
						simpleLanguageService.dispose();
						simpleLanguageService = undefined;
					}
				},
			},
			createVueLanguageServicePlugins(ts, {
				collectExtractProps(...args) {
					return sendTsServerRequest('_vue:collectExtractProps', args);
				},
				getComponentDirectives(...args) {
					return sendTsServerRequest('_vue:getComponentDirectives', args);
				},
				getComponentMeta(...args) {
					return sendTsServerRequest('_vue:getComponentMeta', args);
				},
				getComponentNames(...args) {
					return sendTsServerRequest('_vue:getComponentNames', args);
				},
				getComponentProps(...args) {
					return sendTsServerRequest('_vue:getComponentProps', args);
				},
				getComponentSlots(...args) {
					return sendTsServerRequest('_vue:getComponentSlots', args);
				},
				getElementAttrs(...args) {
					return sendTsServerRequest('_vue:getElementAttrs', args);
				},
				getElementNames(...args) {
					return sendTsServerRequest('_vue:getElementNames', args);
				},
				getImportPathForFile(...args) {
					return sendTsServerRequest('_vue:getImportPathForFile', args);
				},
				getAutoImportSuggestions(...args) {
					return sendTsServerRequest('_vue:getAutoImportSuggestions', args);
				},
				resolveAutoImportCompletionEntry(...args) {
					return sendTsServerRequest('_vue:resolveAutoImportCompletionEntry', args);
				},
				isRefAtPosition(...args) {
					return sendTsServerRequest('_vue:isRefAtPosition', args);
				},
				resolveModuleName(...args) {
					return sendTsServerRequest('_vue:resolveModuleName', args);
				},
				getDocumentHighlights(fileName, position) {
					return sendTsServerRequest(
						'_vue:documentHighlights-full',
						{
							file: fileName,
							...{ position } as unknown as { line: number; offset: number },
							filesToSearch: [fileName],
						} satisfies ts.server.protocol.DocumentHighlightsRequestArgs,
					);
				},
				getEncodedSemanticClassifications(fileName, span) {
					return sendTsServerRequest(
						'_vue:encodedSemanticClassifications-full',
						{
							file: fileName,
							...span,
							format: ts.SemanticClassificationFormat.TwentyTwenty,
						} satisfies ts.server.protocol.EncodedSemanticClassificationsRequestArgs,
					);
				},
				async getQuickInfoAtPosition(fileName, { line, character }) {
					const result = await sendTsServerRequest<ts.server.protocol.QuickInfoResponseBody>(
						'_vue:' + ts.server.protocol.CommandTypes.Quickinfo,
						{
							file: fileName,
							line: line + 1,
							offset: character + 1,
						} satisfies ts.server.protocol.FileLocationRequestArgs,
					);
					return result?.displayString;
				},
			}),
		);

		const packageJson = require('../package.json');
		result.serverInfo = {
			name: packageJson.name,
			version: packageJson.version,
		};

		return result;

		async function sendTsServerRequest<T>(command: string, args: any): Promise<T | null> {
			return await new Promise<T | null>(resolve => {
				const requestId = ++tsserverRequestId;
				tsserverRequestHandlers.set(requestId, resolve);
				connection.sendNotification('tsserver/request', [requestId, command, args]);
			});
		}

		function createProjectLanguageService(server: LanguageServer, tsconfig: string | undefined) {
			const commonLine = tsconfig && !ts.server.isInferredProjectName(tsconfig)
				? createParsedCommandLine(ts, ts.sys, tsconfig)
				: createParsedCommandLineByJson(ts, ts.sys, ts.sys.getCurrentDirectory(), {});
			const language = createLanguage<URI>(
				[
					{
						getLanguageId: uri => server.documents.get(uri)?.languageId,
					},
					createVueLanguagePlugin(
						ts,
						commonLine.options,
						commonLine.vueOptions,
						uri => uri.fsPath.replace(/\\/g, '/'),
					),
				],
				createUriMap(),
				uri => {
					const document = server.documents.get(uri);
					if (document) {
						language.scripts.set(uri, document.getSnapshot(), document.languageId);
					}
					else {
						language.scripts.delete(uri);
					}
				},
			);
			const languageService = createLanguageService(
				language,
				server.languageServicePlugins,
				createLanguageServiceEnvironment(server, [...server.workspaceFolders.all]),
				{},
			);
			if (componentHoverVersion === 1) {
				const getHover = languageService.getHover;
				languageService.getHover = async (uri, position, token) => {
					if (token?.isCancellationRequested) {
						return;
					}
					const documentBeforeConfiguration = server.documents.get(uri);
					const versionBeforeConfiguration = documentBeforeConfiguration?.version;
					const richHover = await languageService.context.env.getConfiguration?.('vue.hover.rich');
					if (
						token?.isCancellationRequested
						|| server.documents.get(uri) !== documentBeforeConfiguration
						|| documentBeforeConfiguration?.version !== versionBeforeConfiguration
					) {
						return;
					}
					if (richHover === false) {
						return getHover(uri, position, token);
					}
					const document = server.documents.get(uri);
					if (!document || document.languageId !== 'vue') {
						return getHover(uri, position, token);
					}
					const documentVersion = document.version;
					const sourceScript = language.scripts.get(uri);
					const root = sourceScript?.generated?.root as VueVirtualCode | undefined;
					const template = root?.ir.template;
					const offset = document.offsetAt(position);
					const match = template?.lang === 'html' && template.ast
						? findComponentTagAtOffset(template.ast, template.startTagEnd, offset)
						: undefined;
					if (!root || !match) {
						return getHover(uri, position, token);
					}
					const meta = await sendTsServerRequest<ZedraComponentMeta>('_vue:getComponentMeta', [
						root.fileName,
						match.name,
					]);
					if (
						token?.isCancellationRequested
						|| server.documents.get(uri) !== document
						|| document.version !== documentVersion
					) {
						return;
					}
					if (!meta) {
						return getHover(uri, position, token);
					}
					const component = createZedraComponentHover(meta, match.name);
					return {
						contents: { kind: 'markdown', value: formatZedraComponentHover(component) },
						range: { start: document.positionAt(match.start), end: document.positionAt(match.end) },
						zedraComponent: component,
					} as Awaited<ReturnType<typeof getHover>>;
				};
			}
			return languageService;
		}
	});

	connection.onInitialized(server.initialized);

	connection.onShutdown(server.shutdown);
}
