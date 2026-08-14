<template>
  <!-- The second step of a login: an attempt is pending, a factor proves it
       (ADR-0012/0013). Shared by login, password reset, and magic links. -->
  <div class="flex flex-col items-center gap-4">
    <UIcon
      name="i-lucide-shield-check"
      class="size-8 text-primary"
    />
    <div class="text-center">
      <h2 class="text-xl font-semibold">
        {{ recoveryMode ? 'Enter a recovery code' : 'Enter your code' }}
      </h2>
      <p class="mt-1 text-sm text-muted">
        {{ recoveryMode
          ? 'One of the codes you saved when setting up two-step sign-in. Each works once.'
          : 'Open your authenticator app and enter the six-digit code for your NNT account.' }}
      </p>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      icon="i-lucide-alert-circle"
      :title="errorMessage"
    />

    <!-- Authenticator code -->
    <UPinInput
      v-if="!recoveryMode"
      v-model="pin"
      :length="6"
      otp
      type="number"
      autofocus
      :autofocus-delay="150"
      size="lg"
      :disabled="verifying"
      @complete="submitCode(pin.join(''))"
    />

    <!-- Recovery code -->
    <UForm
      v-else
      :state="recoveryForm"
      class="flex w-full max-w-xs flex-col gap-3"
      @submit="submitCode(recoveryForm.code)"
    >
      <UFormField name="code">
        <UInput
          v-model="recoveryForm.code"
          placeholder="xxxx-xxxx-xxxx"
          autocomplete="off"
          autofocus
          class="w-full font-mono"
        />
      </UFormField>
      <UButton
        type="submit"
        block
        :loading="verifying"
        :disabled="recoveryForm.code.trim().length < 6"
      >
        Verify
      </UButton>
    </UForm>

    <div class="flex flex-col items-center gap-2">
      <UButton
        v-if="hasTotp"
        variant="link"
        color="neutral"
        class="p-0"
        @click="toggleMode"
      >
        {{ recoveryMode ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code' }}
      </UButton>

      <UButton
        v-if="methods.includes('passkey') && passkeySupported"
        variant="outline"
        color="neutral"
        icon="i-lucide-key-round"
        block
        :loading="passkeyBusy"
        @click="onPasskey"
      >
        Use a passkey instead
      </UButton>

      <UButton
        variant="link"
        color="neutral"
        class="p-0"
        @click="emit('restart')"
      >
        Start again
      </UButton>
    </div>
  </div>
</template>

<script lang="ts" setup>
const props = defineProps<{
  attemptId: string
  methods: string[]
}>()

const emit = defineEmits<{
  /** A factor was proven and the session sealed — navigate away. */
  verified: []
  /** The attempt is dead (expired and not re-issued) — back to step one. */
  restart: []
}>()

const { fetch: refreshSession } = useUserSession()
const { authenticate, isSupported: passkeySupported } = useWebAuthn()

const hasTotp = computed(() => props.methods.includes('totp'))

// Recovery is the fallback, unless no authenticator app is enrolled at all.
const recoveryMode = ref(!hasTotp.value)

// A wrong code burns the attempt; the server hands back a fresh one so a
// typo doesn't cost the whole first step. Track the live id here.
const currentAttemptId = ref(props.attemptId)
watch(() => props.attemptId, id => (currentAttemptId.value = id))

const pin = ref<number[]>([])
const recoveryForm = reactive({ code: '' })
const errorMessage = ref('')
const verifying = ref(false)
const passkeyBusy = ref(false)

function toggleMode() {
  recoveryMode.value = !recoveryMode.value
  errorMessage.value = ''
}

async function submitCode(code: string) {
  if (verifying.value || code.trim().length < 6) return

  verifying.value = true
  errorMessage.value = ''
  try {
    await $fetch('/api/auth/mfa/verify', {
      method: 'POST',
      body: { attemptId: currentAttemptId.value, code },
    })
    await refreshSession()
    emit('verified')
  }
  catch (error) {
    const reissued = (error as { data?: { data?: { attemptId?: string } } })?.data?.data?.attemptId
    if (reissued) {
      currentAttemptId.value = reissued
      errorMessage.value = getErrorMessage(error, 'That code was not correct.')
      pin.value = []
      recoveryForm.code = ''
    }
    else {
      emit('restart')
    }
  }
  finally {
    verifying.value = false
  }
}

async function onPasskey() {
  errorMessage.value = ''
  passkeyBusy.value = true
  try {
    await authenticate()
    await refreshSession()
    emit('verified')
  }
  catch (error) {
    // A cancelled prompt throws too — say nothing rather than alarm them.
    if ((error as { name?: string })?.name !== 'NotAllowedError') {
      errorMessage.value = getErrorMessage(error, 'That passkey could not be used. Enter a code instead.')
    }
  }
  finally {
    passkeyBusy.value = false
  }
}
</script>
