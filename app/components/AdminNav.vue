<template>
  <!--
    Labels are hidden below `sm` — at 375px four labelled tabs compress to
    "U." / "A..." / "Servic...", which is worse than icons alone (#18).
    Each item keeps an accessible name via aria-label so the icon-only
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
  { label: 'Service tokens', to: '/admin/service-tokens', icon: 'i-lucide-key-square', ariaLabel: 'Service tokens' },
]
</script>
