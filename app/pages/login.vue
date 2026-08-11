<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard
      class="w-full max-w-md"
      highlight
      highlight-color="secondary"
    >
      <UAuthForm
        :schema="schema"
        :fields="fields"
        title="Log in to your NNT account"
        icon="i-lucide-circle-user-round"
        @submit="onSubmit"
      >
        <template #password-hint>
          <ULink
            :to="withRedirect('/forgot-password')"
            class="text-primary font-medium"
            tabindex="-1"
          >
            Forgot password?
          </ULink>
        </template>

        <template #validation>
          <UAlert
            v-if="errorMessage"
            color="error"
            icon="i-lucide-alert-circle"
            :title="errorMessage"
          />
        </template>

        <template #footer>
          Don't have an account?
          <ULink
            :to="withRedirect('/register')"
            class="text-primary font-medium"
          >
            Sign up
          </ULink>
        </template>
      </UAuthForm>
    </UPageCard>
  </UContainer>
</template>

<script lang="ts" setup>
import z from 'zod/v4'
import type { AuthFormField, FormSubmitEvent } from '@nuxt/ui'

const { fetch: refreshSession } = useUserSession()
const { navigateToTarget, withRedirect } = useRedirectTarget()

definePageMeta({
  middleware: 'guest',
  title: 'Log in',
  description: 'Log in to your NNT account',
})

const errorMessage = ref('')

const schema = z.object({
  email: z.email('Please enter a valid email address'),
  password: z.string('Password is required').min(1, 'Password is required'),
})

type Schema = z.output<typeof schema>

const fields: AuthFormField[] = [
  {
    name: 'email',
    type: 'text' as const,
    label: 'Email',
    placeholder: 'Enter your email address',
    required: true,
    autocomplete: 'email',
  },
  {
    name: 'password',
    type: 'password' as const,
    label: 'Password',
    placeholder: 'Enter your password',
    required: true,
    autocomplete: 'current-password',
  },
]

async function onSubmit(event: FormSubmitEvent<Schema>) {
  errorMessage.value = ''

  try {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: event.data,
    })
    await refreshSession()
    await navigateToTarget()
  }
  catch (error) {
    errorMessage.value = getErrorMessage(error, 'An unexpected error occurred. Please try again.')
  }
}
</script>
