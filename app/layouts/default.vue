<script lang="ts" setup>
import { hasRole } from '@newtheatre/auth-types'

// Logged out, the header is empty — those visitors are on /login or /register.
const { loggedIn, user } = useUserSession()
const isAdmin = computed(() => hasRole(user.value, 'auth', 'ADMIN'))
</script>

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

        <div
          v-if="loggedIn"
          class="flex items-center gap-1"
        >
          <UButton
            v-if="isAdmin"
            to="/admin"
            variant="ghost"
            color="neutral"
            size="sm"
            icon="i-lucide-shield"
            label="Admin"
          />
          <UButton
            to="/account"
            variant="ghost"
            color="neutral"
            size="sm"
            icon="i-lucide-circle-user-round"
            :label="user?.name || 'Account'"
          />
        </div>
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
