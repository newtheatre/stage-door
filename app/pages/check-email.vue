<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard
      class="w-full max-w-md text-center"
      :title="loggedIn ? 'Check your email' : 'Check your email'"
      icon="i-lucide-mail-check"
    >
      <template #description>
        <template v-if="loggedIn">
          We've sent a verification link to <strong>{{ user?.email }}</strong>.
          You're logged in already: verifying just confirms the address is yours.
        </template>
        <template v-else>
          If this address didn't already have an account, we've sent it a
          verification link. If it did, we've sent a reminder with a
          password-reset link instead.
        </template>
      </template>

      <div class="flex flex-col gap-2">
        <UButton
          v-if="loggedIn"
          :to="target"
          :external="target.startsWith('https://')"
          block
        >
          Continue
        </UButton>
        <UButton
          v-else
          :to="withRedirect('/login')"
          variant="outline"
          block
        >
          Back to log in
        </UButton>
      </div>
    </UPageCard>
  </UContainer>
</template>

<script lang="ts" setup>
const { loggedIn, user } = useUserSession()
const { target, withRedirect } = useRedirectTarget()

definePageMeta({
  title: 'Check your email',
})
</script>
