<template>
  <UApp>
    <NuxtRouteAnnouncer />

    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script lang="ts" setup>
// definePageMeta({ title }) doesn't reach the document on its own — bridge
// it here so every page's existing titles actually apply.
const route = useRoute()
useHead({
  title: () => (route.meta.title as string | undefined) ?? 'NNT Account',
  titleTemplate: title => title === 'NNT Account' ? title : `${title} · NNT Account`,
})
</script>
