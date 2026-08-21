<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard class="w-full max-w-md">
      <!-- Second step for MFA-enrolled accounts: the reset changed the
           password, but the factor still gates the session (ADR-0013). -->
      <MfaChallenge
        v-if="challenge"
        :attempt-id="challenge.attemptId"
        :methods="challenge.methods"
        @verified="navigateToTarget"
        @restart="onChallengeRestart"
      />

      <UAuthForm
        v-else-if="token"
        :schema="schema"
        :fields="fields"
        title="Choose a new password"
        icon="i-lucide-key-round"
        :submit="{ label: 'Set new password' }"
        @submit="onSubmit"
      >
        <template #validation>
          <UAlert
            v-if="errorMessage"
            color="error"
            icon="i-lucide-alert-circle"
            :title="errorMessage"
          />
        </template>
      </UAuthForm>

      <div
        v-else
        class="text-center flex flex-col gap-4 py-4"
      >
        <UIcon
          name="i-lucide-alert-circle"
          class="size-10 mx-auto text-error"
        />
        <p class="font-medium">
          This reset link is missing its token.
        </p>
        <p class="text-sm text-muted">
          Use the link from your email, or request a new one.
        </p>
        <UButton
          to="/forgot-password"
          variant="outline"
          block
        >
          Request a new link
        </UButton>
      </div>
    </UPageCard>
  </UContainer>
</template>

<script lang="ts" setup>
import z from 'zod'
import type { AuthFormField, FormSubmitEvent } from '@nuxt/ui'

const route = useRoute()
const { fetch: refreshSession } = useUserSession()
const { navigateToTarget } = useRedirectTarget()

definePageMeta({
  title: 'Reset password',
  description: 'Set a new password for your NNT account',
})

const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')
const errorMessage = ref('')

// Set when the reset succeeds but the account has a second factor enrolled.
const challenge = ref<{ attemptId: string, methods: string[] } | null>(null)

function onChallengeRestart() {
  // The password DID change; only the attempt died. Back to login, where
  // the new password starts a fresh challenge.
  navigateTo('/login')
}

const schema = z.object({
  password: passwordSchema,
})

type Schema = z.output<typeof schema>

const fields: AuthFormField[] = [
  {
    name: 'password',
    type: 'password' as const,
    label: 'New password',
    placeholder: 'Choose a new password',
    required: true,
    autocomplete: 'new-password',
  },
]

async function onSubmit(event: FormSubmitEvent<Schema>) {
  errorMessage.value = ''

  try {
    const result = await $fetch('/api/auth/password/reset', {
      method: 'POST',
      body: { token: token.value, password: event.data.password },
    })
    if ('mfaRequired' in result && result.mfaRequired) {
      challenge.value = { attemptId: result.attemptId, methods: result.methods }
      return
    }
    // A successful reset logs the user in (docs/api-reference.md).
    await refreshSession()
    await navigateToTarget()
  }
  catch (error) {
    errorMessage.value = getErrorMessage(error, 'An unexpected error occurred. Please try again.')
  }
}
</script>
