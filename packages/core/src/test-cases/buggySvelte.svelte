<script>
  import { onDestroy } from 'svelte';
  import { count } from './store.js';

  // ⚠️ BUG 1: Manual store subscription without variable assignment (uncleaned)
  count.subscribe(value => {
    console.log('Unassigned sub:', value);
  });

  // ⚠️ BUG 2: Manual store subscription stored in variable but never cleaned up in onDestroy
  const unsubscribe = count.subscribe(value => {
    console.log('Uncleaned variable sub:', value);
  });

  // ✅ CLEAN: Manual store subscription with proper unsubscribe in onDestroy
  const unsubscribeClean = count.subscribe(value => {
    console.log('Clean variable sub:', value);
  });
  onDestroy(() => {
    unsubscribeClean();
  });
</script>

<h1>Svelte Component</h1>
