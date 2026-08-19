<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard class="w-full max-w-md text-center">
      <div
        v-if="state === 'verifying'"
        class="flex flex-col gap-4 py-4"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-10 mx-auto animate-spin text-primary"
        />
        <p class="font-medium">
          Verifying your email address…
        </p>
      </div>

      <div
        v-else-if="state === 'success'"
        class="flex flex-col gap-4 py-4"
      >
        <UIcon
          name="i-lucide-badge-check"
          class="size-10 mx-auto text-success"
        />
        <p class="font-medium">
          Email verified: you're all set.
        </p>
        <UButton
          :to="target"
          :external="target.startsWith('https://')"
          block
        >
          Continue
        </UButton>
      </div>

      <div
        v-else
        class="flex flex-col gap-4 py-4"
      >
        <UIcon
          name="i-lucide-alert-circle"
          class="size-10 mx-auto text-error"
        />
        <p class="font-medium">
          {{ errorMessage }}
        </p>
        <UButton
          v-if="loggedIn"
          variant="outline"
          block
          :loading="resending"
          @click="resend"
        >
          {{ resent ? 'Sent: check your inbox' : 'Send a new verification link' }}
        </UButton>
        <UButton
          v-else
          to="/login"
          variant="outline"
          block
        >
          Log in
        </UButton>
      </div>
    </UPageCard>
  </UContainer>
</template>

<script lang="ts" setup>
const route = useRoute()
const { loggedIn, fetch: refreshSession } = useUserSession()
const { target } = useRedirectTarget()

definePageMeta({
  title: 'Verify email',
})

const state = ref<'verifying' | 'success' | 'error'>('verifying')
const errorMessage = ref('')
const resending = ref(false)
const resent = ref(false)

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : ''

  if (!token) {
    state.value = 'error'
    errorMessage.value = 'This verification link is missing its token. Use the link from your email.'
    return
  }

  try {
    await $fetch('/api/auth/email/verify', {
      method: 'POST',
      body: { token },
    })
    await refreshSession()
    state.value = 'success'
  }
  catch (error) {
    state.value = 'error'
    errorMessage.value = getErrorMessage(error, 'Verification failed. Please try again.')
  }
})

async function resend() {
  resending.value = true
  try {
    await $fetch('/api/auth/email/request', { method: 'POST' })
    resent.value = true
  }
  catch (error) {
    errorMessage.value = getErrorMessage(error, 'Could not send a new link. Please try again later.')
  }
  finally {
    resending.value = false
  }
}
</script>
