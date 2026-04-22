<script lang="ts">
	import './layout.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/png" href="images/gumboots_460.png" />
</svelte:head>

{@render children()}
