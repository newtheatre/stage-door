<template>
  <!--
  Labels hide below `sm`; each item keeps an aria-label so the icon-only
  state stays usable with a screen reader.
  -->
  <UNavigationMenu
    :items="items"
    class="w-full border-b border-default mb-4"
    :ui="{ linkLabel: 'hidden sm:inline' }"
  />
</template>

<script lang="ts" setup>
const items = [
  { label: 'Users', to: '/admin', icon: 'i-lucide-users', ariaLabel: 'Users' },
  { label: 'Role definitions', to: '/admin/roles', icon: 'i-lucide-shield-check', ariaLabel: 'Role definitions' },
  { label: 'Audit log', to: '/admin/audit', icon: 'i-lucide-scroll-text', ariaLabel: 'Audit log' },
  { label: 'Permissions', to: '/admin/permissions', icon: 'i-lucide-key-round', ariaLabel: 'Permissions' },
  { label: 'Apps', to: '/admin/apps', icon: 'i-lucide-boxes', ariaLabel: 'Apps' },
  { label: 'Service tokens', to: '/admin/service-tokens', icon: 'i-lucide-key-square', ariaLabel: 'Service tokens' },
]
</script>
