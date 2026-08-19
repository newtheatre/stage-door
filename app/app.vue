<template>
  <UApp :locale="en_gb">
    <NuxtRouteAnnouncer />

    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script lang="ts" setup>
// British English throughout (CLAUDE.md): this drives UInputDate/UCalendar
// formatting (DD/MM/YYYY), not just component strings.
import { en_gb } from '@nuxt/ui/locale'

// definePageMeta({ title }) doesn't reach the document on its own: bridge
// it here so every page's existing titles actually apply.
const route = useRoute()
useHead({
  title: () => (route.meta.title as string | undefined) ?? 'NNT Account',
  titleTemplate: title => title === 'NNT Account' ? title : `${title} · NNT Account`,
})
</script>
