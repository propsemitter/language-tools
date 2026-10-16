import type HoverChild from './HoverChild.vue';

declare module 'vue' {
	interface GlobalComponents {
		GlobalHoverChild: typeof HoverChild;
	}
}

export {};
