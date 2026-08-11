<template>
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-default">
      <UContainer class="flex items-center justify-between h-14">
        <NuxtLink
          to="/"
          class="font-bold text-primary"
        >
          The Nottingham New Theatre
        </NuxtLink>
        <span class="text-sm text-muted">Account</span>
      </UContainer>
    </header>

    <main class="flex-1 flex flex-col">
      <slot />
    </main>

    <footer class="border-t border-default py-4">
      <UContainer class="text-xs text-muted flex justify-between">
        <span>One account for everything NNT.</span>
        <ULink
          to="https://newtheatre.org.uk"
          class="hover:text-primary"
        >
          newtheatre.org.uk
        </ULink>
      </UContainer>
    </footer>
  </div>
</template>
