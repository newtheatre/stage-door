<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard
      class="w-full max-w-md"
      :title="loggedIn ? `Hello, ${user?.name}` : 'NNT Account'"
      :description="loggedIn
        ? 'You\'re logged in across all NNT sites.'
        : 'One account for tickets, room bookings, and everything NNT.'"
      icon="i-lucide-circle-user-round"
    >
      <div
        v-if="loggedIn"
        class="flex flex-col gap-3"
      >
        <div class="text-sm flex flex-col gap-1">
          <p class="text-muted">
            {{ user?.email }}
          </p>
          <p
            v-if="!user?.verified"
            class="text-warning"
          >
            Email not yet verified —
            <ULink
              to="/verify-email"
              class="underline"
            >verify now</ULink>.
          </p>
        </div>

        <USeparator />

        <UButton
          to="/account"
          variant="ghost"
          icon="i-lucide-settings"
          block
        >
          Manage your account
        </UButton>
        <UButton
          v-if="isAdmin"
          to="/admin"
          variant="ghost"
          icon="i-lucide-shield"
          block
        >
          Admin
        </UButton>
        <UButton
          to="https://newtheatre.org.uk"
          external
          variant="ghost"
          icon="i-lucide-ticket"
          block
        >
          Back to newtheatre.org.uk
        </UButton>
        <UButton
          variant="outline"
          color="neutral"
          icon="i-lucide-log-out"
          block
          :loading="loggingOut"
          @click="logout"
        >
          Log out everywhere
        </UButton>
      </div>

      <div
        v-else
        class="flex flex-col gap-2"
      >
        <UButton
          to="/login"
          block
        >
          Log in
        </UButton>
        <UButton
          to="/register"
          variant="outline"
          block
        >
          Create an account
        </UButton>
      </div>
    </UPageCard>
  </UContainer>
</template>

<script lang="ts" setup>
import { hasRole } from '@newtheatre/auth-types'

const { loggedIn, user, clear } = useUserSession()

definePageMeta({
  title: 'NNT Account',
})

const isAdmin = computed(() => hasRole(user.value, 'auth', 'ADMIN'))

const loggingOut = ref(false)

async function logout() {
  loggingOut.value = true
  try {
    await $fetch('/api/auth/logout', { method: 'POST' })
    await clear()
  }
  finally {
    loggingOut.value = false
  }
}
</script>
