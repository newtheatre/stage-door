<template>
  <UPageCard
    class="w-full"
    title="Two-step sign-in"
    icon="i-lucide-shield-check"
    :description="status?.required
      ? 'Your account can change things across NNT sites, so it must have a second step at sign-in as well as a password.'
      : 'Add a second step to your sign-in. Recommended for anyone with an NNT role.'"
  >
    <div class="flex flex-col gap-6">
      <UAlert
        v-if="status?.required && status.factors.length === 0"
        color="warning"
        icon="i-lucide-triangle-alert"
        title="Set this up to keep your NNT admin access"
        description="Until you finish, you can still use your account normally, but admin tools will refuse to open."
      />

      <!-- One-time reveal: codes are hashed the moment they are generated. -->
      <UAlert
        v-if="revealedCodes"
        color="success"
        icon="i-lucide-life-buoy"
        title="Save your recovery codes now"
      >
        <template #description>
          <p class="mb-3">
            Each code works once, if you ever lose your phone or passkey. This
            is the only time they are shown — keep them in your password
            manager.
          </p>
          <ul class="grid grid-cols-2 gap-1 font-mono text-sm mb-3">
            <li
              v-for="code in revealedCodes"
              :key="code"
            >
              {{ code }}
            </li>
          </ul>
          <div class="flex gap-2">
            <UButton
              size="sm"
              variant="outline"
              icon="i-lucide-copy"
              @click="copy(revealedCodes.join('\n'), 'Recovery codes copied')"
            >
              Copy
            </UButton>
            <UButton
              size="sm"
              variant="ghost"
              @click="dismissCodes"
            >
              I've saved them
            </UButton>
          </div>
        </template>
      </UAlert>

      <!-- Passkeys -->
      <div class="flex flex-col gap-3">
        <h3 class="font-medium">
          Passkeys
        </h3>
        <p class="text-sm text-muted">
          Sign in with your fingerprint, face or device PIN — no password and
          no code to type. A passkey works only on the site it was made for,
          so it can't be phished.
        </p>

        <ul
          v-if="status?.passkeys.length"
          class="flex flex-col gap-2"
        >
          <li
            v-for="passkey in status.passkeys"
            :key="passkey.id"
            class="flex items-center justify-between gap-2 rounded-md border border-default p-3"
          >
            <div class="min-w-0">
              <p class="truncate font-medium">
                {{ passkey.name }}
              </p>
              <p class="text-xs text-muted">
                Added {{ formatDate(passkey.createdAt) }} ·
                {{ passkey.lastUsedAt ? `last used ${formatDate(passkey.lastUsedAt)}` : 'never used' }}
              </p>
            </div>
            <UButton
              variant="ghost"
              color="error"
              icon="i-lucide-trash-2"
              :aria-label="`Remove ${passkey.name}`"
              @click="askRemove(passkey.id, passkey.name)"
            />
          </li>
        </ul>

        <div
          v-if="passkeySupported"
          class="flex flex-wrap items-end gap-2"
        >
          <UFormField
            label="Name this device"
            name="passkeyLabel"
            class="grow"
          >
            <UInput
              v-model="passkeyLabel"
              placeholder="e.g. My phone"
              class="w-full"
            />
          </UFormField>
          <UButton
            variant="outline"
            icon="i-lucide-key-round"
            :loading="busy === 'passkey-add'"
            @click="addPasskey"
          >
            Add a passkey
          </UButton>
        </div>
        <p
          v-else
          class="text-sm text-muted"
        >
          This browser doesn't support passkeys — use an authenticator app
          instead.
        </p>
      </div>

      <USeparator />

      <!-- Authenticator app -->
      <div class="flex flex-col gap-3">
        <h3 class="font-medium">
          Authenticator app
        </h3>

        <template v-if="status?.factors.includes('totp')">
          <p class="text-sm text-muted">
            <UIcon
              name="i-lucide-circle-check"
              class="text-success align-text-bottom"
            />
            Set up. You'll be asked for a six-digit code when you sign in with
            your password.
          </p>
          <UButton
            variant="outline"
            color="error"
            class="self-start"
            @click="askRemove('totp', 'your authenticator app')"
          >
            Remove authenticator app
          </UButton>
        </template>

        <template v-else-if="setup">
          <p class="text-sm text-muted">
            Scan this with your authenticator app — or, for a shared account,
            paste the key into the committee password manager.
          </p>
          <img
            :src="qrSrc"
            alt="QR code containing your authenticator setup key"
            class="w-40 rounded-md bg-white p-2"
          >
          <div class="flex items-center gap-2">
            <code class="grow break-all rounded-md bg-elevated p-2 text-sm">{{ setup.secret }}</code>
            <UButton
              size="sm"
              variant="outline"
              icon="i-lucide-copy"
              aria-label="Copy setup key"
              @click="copy(setup!.secret, 'Setup key copied')"
            />
          </div>
          <UFormField
            label="Enter the six-digit code to finish"
            name="totpCode"
          >
            <UInput
              v-model="totpCode"
              placeholder="123456"
              autocomplete="one-time-code"
              inputmode="numeric"
              class="w-full max-w-40"
            />
          </UFormField>
          <div class="flex gap-2">
            <UButton
              :loading="busy === 'totp-confirm'"
              @click="confirmTotp"
            >
              Confirm
            </UButton>
            <UButton
              variant="ghost"
              color="neutral"
              @click="cancelTotp"
            >
              Cancel
            </UButton>
          </div>
        </template>

        <template v-else>
          <p class="text-sm text-muted">
            Use an app such as Google Authenticator, 1Password or Authy to
            generate a six-digit code. Best for accounts shared by a
            committee role, where the key lives in the password manager.
          </p>
          <UButton
            variant="outline"
            icon="i-lucide-smartphone"
            class="self-start"
            :loading="busy === 'totp-start'"
            @click="startTotp"
          >
            Set up authenticator app
          </UButton>
        </template>
      </div>

      <!-- Recovery codes -->
      <template v-if="status?.factors.length">
        <USeparator />
        <div class="flex flex-col gap-3">
          <h3 class="font-medium">
            Recovery codes
          </h3>
          <p class="text-sm text-muted">
            {{ status.recoveryCodesRemaining }} unused
            {{ status.recoveryCodesRemaining === 1 ? 'code' : 'codes' }} left.
            Generating new ones stops the old ones working.
          </p>
          <UButton
            variant="outline"
            color="neutral"
            class="self-start"
            :loading="busy === 'recovery'"
            @click="regenerateCodes"
          >
            Generate new recovery codes
          </UButton>
        </div>
      </template>
    </div>

    <UModal
      v-model:open="removalOpen"
      title="Remove this sign-in method"
      :description="`You'll no longer be able to use ${pendingRemoval?.label} to sign in.`"
    >
      <template #body>
        <div class="flex gap-2">
          <UButton
            color="error"
            :loading="busy === pendingRemoval?.id"
            @click="removeFactor"
          >
            Remove
          </UButton>
          <UButton
            variant="ghost"
            color="neutral"
            @click="closeRemoval"
          >
            Cancel
          </UButton>
        </div>
      </template>
    </UModal>
  </UPageCard>
</template>

<script lang="ts" setup>
import { renderSVG } from 'uqr'

const toast = useToast()
const { fetch: refreshSession } = useUserSession()
const { register, isSupported: passkeySupported } = useWebAuthn()
const { user } = useUserSession()

const { data: status, refresh } = await useFetch('/api/account/mfa')

const busy = ref<string | null>(null)
const setup = ref<{ secret: string, uri: string } | null>(null)
const totpCode = ref('')
const passkeyLabel = ref('')
const revealedCodes = ref<string[] | null>(null)

// Rendered as a data URI rather than v-html — no raw markup injection, and
// the QR never leaves the browser.
const qrSrc = computed(() => setup.value
  ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(setup.value.uri, { border: 1 }))}`
  : '')

function dismissCodes() {
  revealedCodes.value = null
}

function cancelTotp() {
  setup.value = null
}

function closeRemoval() {
  removalOpen.value = false
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

async function copy(text: string, title: string) {
  await navigator.clipboard.writeText(text)
  toast.add({ title, color: 'success' })
}

function fail(error: unknown, fallback: string) {
  toast.add({ title: getErrorMessage(error, fallback), color: 'error' })
}

async function startTotp() {
  busy.value = 'totp-start'
  try {
    setup.value = await $fetch('/api/account/mfa/totp', { method: 'POST' })
    totpCode.value = ''
  }
  catch (error) {
    fail(error, 'Could not start setting up an authenticator app')
  }
  finally {
    busy.value = null
  }
}

async function confirmTotp() {
  busy.value = 'totp-confirm'
  try {
    const { recoveryCodes } = await $fetch('/api/account/mfa/totp-confirm', {
      method: 'POST',
      body: { code: totpCode.value.trim() },
    })
    setup.value = null
    if (recoveryCodes) revealedCodes.value = recoveryCodes
    // Enrolling a first factor bumps the epoch; the session was re-sealed
    // server-side, so pull the new one down before anything else reads it.
    await Promise.all([refresh(), refreshSession()])
    toast.add({ title: 'Authenticator app set up', color: 'success' })
  }
  catch (error) {
    fail(error, 'That code was not correct')
  }
  finally {
    busy.value = null
  }
}

async function addPasskey() {
  busy.value = 'passkey-add'
  try {
    // userName is required by the module's route contract; the server
    // ignores it and uses the session account instead.
    await register({
      userName: user.value?.email ?? '',
      label: passkeyLabel.value.trim() || 'Passkey',
    })
    passkeyLabel.value = ''
    await Promise.all([refresh(), refreshSession()])
    toast.add({ title: 'Passkey added', color: 'success' })

    // First factor and no codes yet — issue them straight away rather than
    // leaving the account one lost device from a support request.
    if (status.value && status.value.recoveryCodesRemaining === 0) await regenerateCodes()
  }
  catch (error) {
    if ((error as { name?: string })?.name !== 'NotAllowedError') {
      fail(error, 'Could not add that passkey')
    }
  }
  finally {
    busy.value = null
  }
}

const removalOpen = ref(false)
const pendingRemoval = ref<{ id: string, label: string } | null>(null)

function askRemove(id: string, label: string) {
  pendingRemoval.value = { id, label }
  removalOpen.value = true
}

async function removeFactor() {
  const target = pendingRemoval.value
  if (!target) return

  busy.value = target.id
  try {
    await $fetch(`/api/account/mfa/${target.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Removed', color: 'success' })
    removalOpen.value = false
  }
  catch (error) {
    fail(error, 'Could not remove that')
  }
  finally {
    busy.value = null
  }
}

async function regenerateCodes() {
  busy.value = 'recovery'
  try {
    const { recoveryCodes } = await $fetch('/api/account/mfa/recovery-codes', { method: 'POST' })
    revealedCodes.value = recoveryCodes
    await refresh()
  }
  catch (error) {
    fail(error, 'Could not generate recovery codes')
  }
  finally {
    busy.value = null
  }
}
</script>
