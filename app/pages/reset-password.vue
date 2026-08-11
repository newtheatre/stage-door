<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard class="w-full max-w-md">
      <UAuthForm
        v-if="token"
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
import z from 'zod/v4'
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

const schema = z.object({
  password: z.string('Password is required')
    .min(8, 'Password must be at least 8 characters')
    .refine(val => /[a-z]/.test(val), { message: 'Password must contain at least one lowercase letter' })
    .refine(val => /[A-Z]/.test(val), { message: 'Password must contain at least one uppercase letter' })
    .refine(val => /\d/.test(val), { message: 'Password must contain at least one number' }),
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
    await $fetch('/api/auth/password/reset', {
      method: 'POST',
      body: { token: token.value, password: event.data.password },
    })
    // A successful reset logs the user in (docs/api-reference.md).
    await refreshSession()
    await navigateToTarget()
  }
  catch (error) {
    errorMessage.value = getErrorMessage(error, 'An unexpected error occurred. Please try again.')
  }
}
</script>
