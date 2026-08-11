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
        title="Create your NNT account"
        icon="i-lucide-user-round-plus"
        @submit="onSubmit"
      >
        <template #description>
          One account for tickets, room bookings, and everything NNT.
          Members with an <code>@newtheatre.org.uk</code> Google account can
          skip this — Google sign-in arrives with the next phase.
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
          Already have an account?
          <ULink
            :to="withRedirect('/login')"
            class="text-primary font-medium"
          >
            Log in
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
const { raw, withRedirect } = useRedirectTarget()

definePageMeta({
  middleware: 'guest',
  title: 'Create an account',
  description: 'Create your NNT account',
})

const errorMessage = ref('')

const schema = z.object({
  name: z.string('Name is required').min(1, 'Name is required').max(200),
  email: z.email('Please enter a valid email address'),
  password: z.string('Password is required')
    .min(8, 'Password must be at least 8 characters')
    .refine(val => /[a-z]/.test(val), { message: 'Password must contain at least one lowercase letter' })
    .refine(val => /[A-Z]/.test(val), { message: 'Password must contain at least one uppercase letter' })
    .refine(val => /\d/.test(val), { message: 'Password must contain at least one number' }),
})

type Schema = z.output<typeof schema>

const fields: AuthFormField[] = [
  {
    name: 'name',
    type: 'text' as const,
    label: 'Name',
    placeholder: 'Enter your name',
    required: true,
    autocomplete: 'name',
  },
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
    placeholder: 'Choose a password',
    required: true,
    autocomplete: 'new-password',
  },
]

async function onSubmit(event: FormSubmitEvent<Schema>) {
  errorMessage.value = ''

  try {
    await $fetch('/api/auth/register', {
      method: 'POST',
      body: event.data,
    })
    await refreshSession()
    // Response is deliberately identical whether an account was created or
    // one already existed (enumeration safety) — both paths land on the
    // check-your-email page, which adapts to session state.
    await navigateTo(raw.value ? `/check-email?redirect=${encodeURIComponent(raw.value)}` : '/check-email')
  }
  catch (error) {
    errorMessage.value = getErrorMessage(error, 'An unexpected error occurred. Please try again.')
  }
}
</script>
