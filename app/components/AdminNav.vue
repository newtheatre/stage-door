<template>
  <UNavigationMenu
    :items="items"
    class="w-full border-b border-default mb-4"
  />
</template>

<script lang="ts" setup>
const items = [
  { label: 'Users', to: '/admin', icon: 'i-lucide-users' },
  { label: 'Role definitions', to: '/admin/roles', icon: 'i-lucide-shield-check' },
  { label: 'Audit log', to: '/admin/audit', icon: 'i-lucide-scroll-text' },
  { label: 'Service tokens', to: '/admin/service-tokens', icon: 'i-lucide-key-square' },
]
</script>
