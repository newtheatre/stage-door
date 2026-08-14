<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard class="w-full max-w-md">
      <!-- Second step for MFA-enrolled accounts: the link replaces the
           password, never the second factor (ADR-0013). -->
      <MfaChallenge
        v-if="challenge"
        :attempt-id="challenge.attemptId"
        :methods="challenge.methods"
        @verified="navigateToTarget"
        @restart="restartChallenge"
      />

      <!-- Consuming an emailed link -->
      <div
        v-else-if="token && consuming"
        class="text-center flex flex-col gap-4 py-4"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-10 mx-auto animate-spin text-primary"
        />
        <p class="font-medium">
          Signing you in…
        </p>
      </div>

      <div
        v-else-if="token && consumeError"
        class="text-center flex flex-col gap-4 py-4"
      >
        <UIcon
          name="i-lucide-clock-alert"
          class="size-10 mx-auto text-error"
        />
        <p class="font-medium">
          {{ consumeError }}
        </p>
        <p class="text-sm text-muted">
          Links work once and expire after 15 minutes.
        </p>
        <UButton
          variant="outline"
          block
          @click="startOver"
        >
          Send me a new link
        </UButton>
      </div>

      <!-- Requesting a link -->
      <UAuthForm
        v-else-if="!submitted"
        :schema="schema"
        :fields="fields"
        title="Email me a sign-in link"
        description="No password needed — we'll send a link that signs you in. This works even if you've only ever booked tickets with us."
        icon="i-lucide-mail"
        :submit="{ label: 'Send sign-in link' }"
        @submit="onSubmit"
      >
        <template #validation>
          <UAlert
            v-if="useGoogleInstead"
            color="info"
            icon="i-simple-icons-google"
            title="NNT accounts sign in with Google"
            description="Your @newtheatre.org.uk account signs in with Google instead — head back to the login page and use the Google button."
          />
          <UAlert
            v-else-if="errorMessage"
            color="error"
            icon="i-lucide-alert-circle"
            :title="errorMessage"
          />
        </template>

        <template #footer>
          Prefer your password?
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
          If that address has an account, a sign-in link is on its way.
        </p>
        <p class="text-sm text-muted">
          The link works once and expires in 15 minutes. Check your spam
          folder if it doesn't arrive.
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

const route = useRoute()
const router = useRouter()
const { fetch: refreshSession } = useUserSession()
const { raw, navigateToTarget, withRedirect } = useRedirectTarget()

definePageMeta({
  // Deliberately NOT the guest middleware: someone signed in on another account
  // must still be able to consume an emailed link.
  title: 'Email sign-in link',
  description: 'Sign in to your NNT account with an emailed link',
})

const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')

const errorMessage = ref('')
const submitted = ref(false)
const useGoogleInstead = ref(false)

const consuming = ref(false)
const consumeError = ref('')
const challenge = ref<{ attemptId: string, methods: string[] } | null>(null)

const schema = z.object({
  email: z.email('Please enter a valid email address'),
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
    await $fetch('/api/auth/magic-link/request', {
      method: 'POST',
      body: { email: event.data.email, ...(raw.value ? { redirect: raw.value } : {}) },
    })
    submitted.value = true
  }
  catch (error) {
    if ((error as { data?: { data?: { useGoogle?: boolean } } })?.data?.data?.useGoogle) {
      useGoogleInstead.value = true
      return
    }
    errorMessage.value = getErrorMessage(error, 'An unexpected error occurred. Please try again.')
  }
}

async function consume() {
  consuming.value = true
  consumeError.value = ''
  try {
    const result = await $fetch('/api/auth/magic-link/verify', {
      method: 'POST',
      body: { token: token.value },
    })
    if ('mfaRequired' in result && result.mfaRequired) {
      challenge.value = { attemptId: result.attemptId, methods: result.methods }
      return
    }
    await refreshSession()
    await navigateToTarget()
  }
  catch (error) {
    consumeError.value = getErrorMessage(error, 'That sign-in link could not be used.')
  }
  finally {
    consuming.value = false
  }
}

function restartChallenge() {
  // The link is spent; the only way forward is a fresh one.
  challenge.value = null
  startOver()
}

function startOver() {
  consumeError.value = ''
  submitted.value = false
  // Drop the dead token from the URL, keep any redirect.
  router.replace({ query: { ...route.query, token: undefined } })
}

// Consume client-side only — the token burns on first use, so SSR + client
// hydration must not both spend it.
onMounted(() => {
  if (token.value) consume()
})
</script>
