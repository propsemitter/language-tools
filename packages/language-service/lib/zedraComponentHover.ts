import type { ComponentMeta, EventMeta, ExposeMeta, PropertyMeta, SlotMeta } from 'vue-component-meta';

export type ZedraComponentMeta = ComponentMeta;

export interface ZedraComponentHoverMember {
	name: string;
	type: string;
	description: string;
	required: boolean;
	deprecated: boolean;
	model: boolean;
	default?: string;
}

export interface ZedraComponentHover {
	version: 1;
	name: string;
	description: string;
	props: ZedraComponentHoverMember[];
	slots: ZedraComponentHoverMember[];
	events: ZedraComponentHoverMember[];
	exposed: ZedraComponentHoverMember[];
}

export function createZedraComponentHover(meta: ComponentMeta, fallbackName: string): ZedraComponentHover {
	const modelNames = new Set<string>();
	for (const event of meta.events) {
		if (event.name.startsWith('update:')) {
			modelNames.add(event.name.slice('update:'.length));
		}
	}
	for (const prop of meta.props) {
		if (prop.name.startsWith('onUpdate:')) {
			modelNames.add(prop.name.slice('onUpdate:'.length));
		}
	}
	return {
		version: 1,
		name: meta.name ?? fallbackName,
		description: meta.description ?? '',
		props: meta.props.filter(prop => !prop.global).map(prop => createMember(prop, modelNames.has(prop.name))),
		slots: meta.slots.map(item => createMember(item)),
		events: meta.events.map(event => ({ ...createMember(event), type: event.signature || event.type })),
		exposed: meta.exposed.map(item => createMember(item)),
	};
}

export function formatZedraComponentHover(hover: ZedraComponentHover): string {
	const sections: string[] = [];
	if (hover.description) {
		sections.push(hover.description);
	}
	const props = hover.props;
	if (props.length) {
		sections.push(`### Props\n\n${props.map(member => formatMember(member)).join('\n')}`);
	}
	for (
		const [heading, members] of [
			['Events', hover.events],
			['Slots', hover.slots],
			['Exposed', hover.exposed],
		] as const
	) {
		if (members.length) {
			sections.push(`### ${heading}\n\n${members.map(member => formatMember(member)).join('\n')}`);
		}
	}
	return sections.length ? sections.join('\n\n---\n\n') : 'No type information available.';
}

function createMember(
	item: PropertyMeta | EventMeta | SlotMeta | ExposeMeta,
	model = false,
): ZedraComponentHoverMember {
	return {
		name: item.name,
		type: item.type,
		description: item.description,
		required: 'required' in item ? item.required : false,
		deprecated: item.tags.some(tag => tag.name === 'deprecated'),
		model,
		...('default' in item && item.default !== undefined ? { default: item.default } : {}),
	};
}

function formatMember(member: ZedraComponentHoverMember): string {
	const flags = [member.required && 'required', member.model && 'model', member.deprecated && 'deprecated']
		.filter((flag): flag is string => !!flag);
	const name = `**${escapeMarkdown(member.name)}**${flags.length ? ` (${flags.join(', ')})` : ''}`;
	const type = formatCodeSpan(member.type);
	const defaultValue = member.default === undefined ? '' : ` — default: ${formatCodeSpan(member.default)}`;
	const description = member.description ? `\n  ${member.description}` : '';
	return `- ${name}: ${type}${defaultValue}${description}`;
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}\[\]()#+\-.!<>|~]/g, '\\$&');
}

function formatCodeSpan(value: string): string {
	const fenceLength = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length)) + 1;
	const fence = '`'.repeat(fenceLength);
	const pad = fenceLength > 1 || value.startsWith('`') || value.endsWith('`')
		|| (value.startsWith(' ') && value.endsWith(' ') && value.trim().length > 0);
	return `${fence}${pad ? ' ' : ''}${value}${pad ? ' ' : ''}${fence}`;
}
