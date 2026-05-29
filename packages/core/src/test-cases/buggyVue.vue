<script setup>
import { onMounted, onUnmounted } from 'vue';

const handleResize = () => console.log('resized');

// ⚠️ BUG 1: Listener registered onMounted but never cleaned up in onUnmounted
onMounted(() => {
  window.addEventListener('resize', handleResize);
});

// ⚠️ BUG 2: Interval registered onMounted but never cleared in onUnmounted
onMounted(() => {
  setInterval(() => {
    console.log('ping');
  }, 1000);
});

// ✅ CLEAN: Listener properly cleaned up
const handleScroll = () => console.log('scroll');
onMounted(() => {
  window.addEventListener('scroll', handleScroll);
});
onUnmounted(() => {
  window.removeEventListener('scroll', handleScroll);
});
</script>

<template>
  <div>Vue Component</div>
</template>
