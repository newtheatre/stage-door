<template>
  <UContainer class="flex flex-col justify-center gap-4 p-4 flex-1 w-full max-w-4xl">
    <!-- Logged in: 2×2 grid — identity spans the left column, estate links
         and the security snapshot stack on the right. -->
    <div
      v-if="loggedIn"
      class="grid gap-4 lg:grid-cols-2"
    >
      <UPageCard
        class="lg:row-span-2"
        highlight
        highlight-color="secondary"
      >
        <div class="flex h-full flex-col gap-4">
          <div class="flex items-center gap-3">
            <div class="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <UIcon
                name="i-lucide-circle-user-round"
                class="size-7 text-primary"
              />
            </div>
            <div class="min-w-0">
              <h1 class="truncate text-lg font-semibold">
                {{ user?.name }}
              </h1>
              <p class="truncate text-sm text-muted">
                {{ user?.email }}
              </p>
            </div>
          </div>

          <UAlert
            v-if="!user?.verified"
            color="warning"
            variant="subtle"
            icon="i-lucide-mail-warning"
            title="Email not yet verified"
          >
            <template #description>
              <ULink
                to="/verify-email"
                class="underline"
              >
                Verify it now
              </ULink>
              to secure your account.
            </template>
          </UAlert>

          <div
            v-if="user?.roles?.length"
            class="flex flex-wrap gap-1"
          >
            <UBadge
              v-for="role in user.roles"
              :key="role"
              color="primary"
              variant="subtle"
              size="sm"
            >
              {{ role }}
            </UBadge>
          </div>

          <p class="text-sm text-muted">
            One login for every NNT site — tickets, room bookings, and the
            tools behind them.
          </p>

          <div class="mt-auto flex flex-col gap-2">
            <UButton
              to="/account"
              icon="i-lucide-settings"
              block
            >
              Manage your account
            </UButton>
            <UButton
              variant="outline"
              color="neutral"
              icon="i-lucide-log-out"
              block
              :loading="loggingOut"
              @click="logout"
            >
              Log out
            </UButton>
          </div>
        </div>
      </UPageCard>

      <UPageCard
        title="Your NNT"
        icon="i-lucide-theater"
      >
        <div class="flex flex-col gap-2">
          <UButton
            to="https://newtheatre.org.uk"
            external
            variant="ghost"
            color="neutral"
            icon="i-lucide-ticket"
            block
            class="justify-start"
            trailing-icon="i-lucide-arrow-up-right"
            :ui="{ trailingIcon: 'ms-auto text-muted' }"
          >
            Tickets &amp; shows — newtheatre.org.uk
          </UButton>
          <UButton
            to="https://rooms.newtheatre.org.uk"
            external
            variant="ghost"
            color="neutral"
            icon="i-lucide-door-open"
            block
            class="justify-start"
            trailing-icon="i-lucide-arrow-up-right"
            :ui="{ trailingIcon: 'ms-auto text-muted' }"
          >
            Room bookings — rooms.newtheatre.org.uk
          </UButton>
        </div>
      </UPageCard>

      <UPageCard
        title="Security"
        icon="i-lucide-shield"
      >
        <div class="flex flex-col gap-3">
          <template v-if="mfa">
            <UAlert
              v-if="mfaLocked"
              color="warning"
              variant="subtle"
              icon="i-lucide-lock"
              title="Admin tools are locked"
              description="Your account requires two-step sign-in. Set it up to unlock them."
            />
            <p
              v-else-if="mfa.factors.length"
              class="text-sm text-muted"
            >
              <UIcon
                name="i-lucide-shield-check"
                class="align-text-bottom text-success"
              />
              Two-step sign-in is on
              ({{ mfa.factors.map(f => f === 'totp' ? 'authenticator app' : 'passkey').join(', ') }}).
            </p>
            <p
              v-else
              class="text-sm text-muted"
            >
              Two-step sign-in is off. A passkey takes a minute to set up and
              stops a stolen password being enough.
            </p>
          </template>

          <div class="flex flex-wrap gap-2">
            <UButton
              to="/account?tab=security"
              variant="outline"
              size="sm"
              icon="i-lucide-shield-check"
            >
              {{ mfa?.factors.length ? 'Manage two-step sign-in' : 'Set up two-step sign-in' }}
            </UButton>
            <UButton
              v-if="isAdmin && !mfaLocked"
              to="/admin"
              variant="outline"
              size="sm"
              icon="i-lucide-shield"
            >
              Open admin
            </UButton>
          </div>
        </div>
      </UPageCard>
    </div>

    <!-- Logged out: most visitors arrive at /login via an app redirect, so
         this stays a single simple card. -->
    <UPageCard
      v-else
      class="w-full max-w-md self-center"
      title="NNT Account"
      description="One account for tickets, room bookings, and everything NNT."
      icon="i-lucide-circle-user-round"
      highlight
      highlight-color="secondary"
    >
      <div class="flex flex-col gap-2">
        <UButton
          to="/login"
          icon="i-lucide-log-in"
          block
        >
          Log in
        </UButton>
        <UButton
          to="/register"
          variant="outline"
          icon="i-lucide-user-round-plus"
          block
        >
          Create an account
        </UButton>
        <ULink
          to="https://newtheatre.org.uk"
          external
          class="mt-2 self-center text-sm text-muted hover:text-primary"
        >
          newtheatre.org.uk
        </ULink>
      </div>
    </UPageCard>
  </UContainer>
</template>

<script lang="ts" setup>
import { hasRole } from '@newtheatre/auth-types'

definePageMeta({
  title: 'NNT Account',
})

const { loggedIn, user, clear } = useUserSession()
const isAdmin = computed(() => hasRole(user.value, 'auth', 'ADMIN'))

// Second-factor snapshot for the security block (logged-in only).
const { data: mfa } = await useFetch('/api/account/mfa', {
  immediate: loggedIn.value,
  server: false,
  lazy: true,
})
const mfaLocked = computed(() => !!mfa.value && mfa.value.required && mfa.value.factors.length === 0)

const loggingOut = ref(false)

// Clears the shared cookie — logs this browser out of every NNT site. The
// stronger epoch-bumping "log out everywhere" lives on /account.
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
