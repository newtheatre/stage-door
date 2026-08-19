<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard
      class="w-full max-w-md"
    >
      <UAuthForm
        v-if="!submitted"
        :schema="schema"
        :fields="fields"
        title="Forgot your password?"
        description="Enter your email and we'll send you a reset link. This also works if you've booked tickets with us before and never set a password."
        icon="i-lucide-key-round"
        :submit="{ label: 'Send reset link' }"
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

        <template #footer>
          Remembered it?
          <ULink
            :to="withRedirect('/login')"
            class="text-primary font-medium"
          >
            Log in
          </ULink>
        </template>
      </UAuthForm>

      <div
        v-else
        class="text-center flex flex-col gap-4 py-4"
      >
        <UIcon
          name="i-lucide-mail-check"
          class="size-10 mx-auto text-primary"
        />
        <p class="font-medium">
          If that address has an account, a reset link is on its way.
        </p>
        <p class="text-sm text-muted">
          The link is valid for one hour. Check your spam folder if it doesn't arrive.
        </p>
        <UButton
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
import z from 'zod/v4'
import type { AuthFormField, FormSubmitEvent } from '@nuxt/ui'

const { withRedirect } = useRedirectTarget()

definePageMeta({
  title: 'Forgot password',
  description: 'Request a password reset link',
})

const errorMessage = ref('')
const submitted = ref(false)

const schema = z.object({
  email: emailSchema,
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
]

async function onSubmit(event: FormSubmitEvent<Schema>) {
  errorMessage.value = ''

  try {
    await $fetch('/api/auth/password/forgot', {
      method: 'POST',
      body: event.data,
    })
    submitted.value = true
  }
  catch (error) {
    errorMessage.value = getErrorMessage(error, 'An unexpected error occurred. Please try again.')
  }
}
</script>
