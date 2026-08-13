<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard
      class="w-full max-w-md"
      highlight
      highlight-color="secondary"
    >
      <!-- Second step: password accepted, factor outstanding (ADR-0012). -->
      <MfaChallenge
        v-if="challenge"
        :attempt-id="challenge.attemptId"
        :methods="challenge.methods"
        @verified="navigateToTarget"
        @restart="restart"
      />

      <UAuthForm
        v-else
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
            v-if="useGoogleInstead"
            color="info"
            icon="i-simple-icons-google"
            title="NNT accounts sign in with Google"
            description="Your @newtheatre.org.uk account doesn't use a password here — use the Google button below and you'll be signed in with everything you had before."
          />
          <UAlert
            v-else-if="errorMessage"
            color="error"
            icon="i-lucide-alert-circle"
            :title="errorMessage"
          />
        </template>

        <template #footer>
          <USeparator
            label="or"
            class="mb-4"
          />
          <UButton
            :to="googleHref"
            external
            variant="outline"
            color="neutral"
            icon="i-simple-icons-google"
            block
            class="mb-4"
          >
            Sign in with Google (NNT accounts)
          </UButton>
          <UButton
            v-if="passkeySupported"
            variant="outline"
            color="neutral"
            icon="i-lucide-key-round"
            block
            class="mb-4"
            :loading="passkeyBusy"
            @click="onPasskey"
          >
            Sign in with a passkey
          </UButton>
          <UButton
            :to="withRedirect('/magic-link')"
            variant="outline"
            color="neutral"
            icon="i-lucide-mail"
            block
            class="mb-4"
          >
            Email me a sign-in link
          </UButton>
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
const { raw, navigateToTarget, withRedirect } = useRedirectTarget()
const route = useRoute()

definePageMeta({
  middleware: 'guest',
  title: 'Log in',
  description: 'Log in to your NNT account',
})

const errorMessage = ref(
  route.query.error === 'google' ? 'Google sign-in failed. Please try again, or use email and password.' : '',
)

// Set when the submitted address is an NNT Workspace one (ADR-0012).
const useGoogleInstead = ref(false)

// The redirect target rides through the OAuth round-trip as `state`
// (validated server-side on the way back out).
const googleHref = computed(() =>
  raw.value ? `/auth/google?state=${encodeURIComponent(raw.value)}` : '/auth/google',
)

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

// Second-factor state, set when /api/auth/login answers `mfaRequired`. The
// attemptId is the only handle on the half-finished login — nothing is
// sealed until it is exchanged for a proven factor.
const challenge = ref<{ attemptId: string, methods: string[] } | null>(null)

const { authenticate, isSupported: passkeySupported } = useWebAuthn()
const passkeyBusy = ref(false)

async function onPasskey() {
  errorMessage.value = ''
  passkeyBusy.value = true
  try {
    await authenticate()
    await refreshSession()
    await navigateToTarget()
  }
  catch (error) {
    // A cancelled prompt throws too — say nothing rather than alarm them.
    if ((error as { name?: string })?.name !== 'NotAllowedError') {
      errorMessage.value = getErrorMessage(error, 'That passkey could not be used. Try your password instead.')
    }
  }
  finally {
    passkeyBusy.value = false
  }
}

function restart() {
  challenge.value = null
  errorMessage.value = ''
}

async function onSubmit(event: FormSubmitEvent<Schema>) {
  errorMessage.value = ''

  try {
    const result = await $fetch('/api/auth/login', {
      method: 'POST',
      body: event.data,
    })
    if ('mfaRequired' in result && result.mfaRequired) {
      challenge.value = { attemptId: result.attemptId, methods: result.methods }
      return
    }
    await refreshSession()
    await navigateToTarget()
  }
  catch (error) {
    // A Workspace address hit the domain rule (ADR-0012) — point at Google
    // rather than leaving them re-typing a password that will never work.
    if ((error as { data?: { data?: { useGoogle?: boolean } } })?.data?.data?.useGoogle) {
      useGoogleInstead.value = true
      errorMessage.value = ''
      return
    }
    errorMessage.value = getErrorMessage(error, 'An unexpected error occurred. Please try again.')
  }
}
</script>
