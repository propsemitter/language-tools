<script setup lang="ts">
withDefaults(defineProps<{
	/** @deprecated Use label instead. */
	oldLabel?: string;
	label: 'a`b' | 'other';
}>(), {
	label: 'a`b',
});

defineEmits<{
	change: [value: string];
	'update:label': [value: string];
}>();

defineSlots<{
	default(props: { value: string }): any;
}>();

defineExpose({ focus: () => {} });
</script>
