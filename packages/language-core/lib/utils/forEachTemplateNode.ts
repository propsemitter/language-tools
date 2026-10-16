import * as CompilerDOM from '@vue/compiler-dom';

export function isComponentElement(node: CompilerDOM.ElementNode): boolean {
	return node.tagType === CompilerDOM.ElementTypes.COMPONENT;
}

export function findComponentTagAtOffset(
	ast: CompilerDOM.RootNode,
	templateOffset: number,
	offset: number,
): { name: string; start: number; end: number } | undefined {
	for (const element of forEachElementNode(ast)) {
		if (!isComponentElement(element)) {
			continue;
		}
		const source = element.loc.source;
		const elementOffset = templateOffset + element.loc.start.offset;
		const openingTag = source.startsWith(`<${element.tag}`) ? 0 : -1;
		const closingPrefix = `</${element.tag}`;
		const closingTag = source.lastIndexOf(closingPrefix);
		const closingSuffix = closingTag < 0 ? '' : source.slice(closingTag + closingPrefix.length).trim();
		const closingTagOffset = closingSuffix === '>' && source.endsWith('>') ? closingTag : -1;
		for (const [tagOffset, nameOffset] of [[openingTag, 1], [closingTagOffset, 2]] as const) {
			if (tagOffset < 0) continue;
			const start = elementOffset + tagOffset + nameOffset;
			const end = start + element.tag.length;
			if (offset >= start && offset <= end) {
				return { name: element.tag, start, end };
			}
		}
	}
}

export function* forEachElementNode(
	node: CompilerDOM.RootNode | CompilerDOM.TemplateChildNode,
): Generator<CompilerDOM.ElementNode> {
	switch (node.type) {
		case CompilerDOM.NodeTypes.ELEMENT: {
			yield node;
		}
		case CompilerDOM.NodeTypes.IF_BRANCH:
		case CompilerDOM.NodeTypes.FOR:
		case CompilerDOM.NodeTypes.ROOT: {
			for (const child of node.children) {
				yield* forEachElementNode(child);
			}
			break;
		}
		case CompilerDOM.NodeTypes.IF: {
			for (const branch of node.branches) {
				yield* forEachElementNode(branch);
			}
			break;
		}
	}
}

export function* forEachInterpolationNode(
	node: CompilerDOM.RootNode | CompilerDOM.TemplateChildNode | CompilerDOM.SimpleExpressionNode,
): Generator<CompilerDOM.InterpolationNode> {
	switch (node.type) {
		case CompilerDOM.NodeTypes.ELEMENT:
		case CompilerDOM.NodeTypes.IF_BRANCH:
		case CompilerDOM.NodeTypes.FOR:
		case CompilerDOM.NodeTypes.ROOT: {
			for (const child of node.children) {
				yield* forEachInterpolationNode(child);
			}
			break;
		}
		case CompilerDOM.NodeTypes.IF: {
			for (const branch of node.branches) {
				yield* forEachInterpolationNode(branch);
			}
			break;
		}
		case CompilerDOM.NodeTypes.COMPOUND_EXPRESSION: {
			for (const child of node.children) {
				if (typeof child === 'object') {
					yield* forEachInterpolationNode(child);
				}
			}
			break;
		}
		case CompilerDOM.NodeTypes.INTERPOLATION: {
			yield node;
			break;
		}
	}
}
