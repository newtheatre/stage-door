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
            icon="i-lucide-life-buoy"
            :loading="busy === 'recovery'"
            @click="regenerateCodes"
          >
            Generate new recovery codes
          </UButton>
        </div>
      </template>
    </div>

    <!-- ── TOTP enrolment modal ─────────────────────────────────────────── -->
    <UModal
      v-model:open="totpOpen"
      title="Set up your authenticator app"
      description="Scan the QR code, then enter the six-digit code it shows to finish."
      :dismissible="false"
    >
      <template #body>
        <div
          v-if="setup"
          class="flex flex-col items-center gap-4"
        >
          <img
            :src="qrSrc"
            alt="QR code containing your authenticator setup key"
            class="w-44 rounded-md bg-white p-2"
          >

          <div class="w-full">
            <p class="mb-1 text-xs text-muted">
              Can't scan? Paste this key into the app — or, for a shared
              account, into the committee password manager:
            </p>
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
          </div>

          <USeparator />

          <UFormField
            :label="confirmError ?? 'Enter the six-digit code'"
            :error="!!confirmError"
            class="flex flex-col items-center"
          >
            <UPinInput
              v-model="pin"
              :length="6"
              otp
              type="number"
              autofocus
              :autofocus-delay="300"
              size="lg"
              :disabled="busy === 'totp-confirm'"
              @complete="confirmTotp"
            />
          </UFormField>

          <div class="flex gap-2">
            <UButton
              :loading="busy === 'totp-confirm'"
              :disabled="pin.join('').length < 6"
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
        </div>
      </template>
    </UModal>

    <!-- ── Recovery codes modal (the only time they are ever shown) ────── -->
    <UModal
      v-model:open="codesOpen"
      title="Save your recovery codes"
      description="Each code works once, if you ever lose your phone or passkey. This is the only time they are shown — keep them in your password manager."
      :dismissible="false"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <ul class="grid grid-cols-2 gap-2 rounded-md bg-elevated p-4 font-mono text-sm">
            <li
              v-for="code in revealedCodes"
              :key="code"
            >
              {{ code }}
            </li>
          </ul>
          <div class="flex flex-wrap gap-2">
            <UButton
              variant="outline"
              icon="i-lucide-download"
              @click="downloadCodes"
            >
              Download
            </UButton>
            <UButton
              variant="outline"
              color="neutral"
              icon="i-lucide-copy"
              @click="copy(revealedCodes!.join('\n'), 'Recovery codes copied')"
            >
              Copy
            </UButton>
            <UButton
              class="ms-auto"
              @click="dismissCodes"
            >
              I've saved them
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- ── Factor removal confirmation ─────────────────────────────────── -->
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
const { fetch: refreshSession, user } = useUserSession()
const { register, isSupported: passkeySupported } = useWebAuthn()

const { data: status, refresh } = await useFetch('/api/account/mfa')

const busy = ref<string | null>(null)
const passkeyLabel = ref('')

// ── TOTP enrolment ──────────────────────────────────────────────────────────

const totpOpen = ref(false)
const setup = ref<{ secret: string, uri: string } | null>(null)
// `type="number"` makes UPinInput's model number[] (and numeric keyboards on mobile).
const pin = ref<number[]>([])
const confirmError = ref<string | null>(null)

// Rendered as a data URI rather than v-html — no raw markup injection, and
// the QR never leaves the browser.
const qrSrc = computed(() => setup.value
  ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(setup.value.uri, { border: 1 }))}`
  : '')

async function startTotp() {
  busy.value = 'totp-start'
  try {
    setup.value = await $fetch('/api/account/mfa/totp', { method: 'POST' })
    pin.value = []
    confirmError.value = null
    totpOpen.value = true
  }
  catch (error) {
    fail(error, 'Could not start setting up an authenticator app')
  }
  finally {
    busy.value = null
  }
}

async function confirmTotp() {
  const code = pin.value.join('')
  if (code.length < 6 || busy.value === 'totp-confirm') return

  busy.value = 'totp-confirm'
  confirmError.value = null
  try {
    const { recoveryCodes } = await $fetch('/api/account/mfa/totp-confirm', {
      method: 'POST',
      body: { code },
    })
    totpOpen.value = false
    setup.value = null
    // Enrolling a first factor bumps the epoch; the session was re-sealed
    // server-side, so pull the new one down before anything else reads it.
    await Promise.all([refresh(), refreshSession()])
    toast.add({ title: 'Authenticator app set up', color: 'success' })
    // Chain straight into the one-time recovery-codes reveal.
    if (recoveryCodes) revealCodes(recoveryCodes)
  }
  catch (error) {
    confirmError.value = getErrorMessage(error, 'That code was not correct — try the next one')
    pin.value = []
  }
  finally {
    busy.value = null
  }
}

// An abandoned enrolment is harmless server-side (the secret is unconfirmed
// and never gates a login), so cancel just closes.
function cancelTotp() {
  totpOpen.value = false
  setup.value = null
}

// ── Recovery codes ──────────────────────────────────────────────────────────

const codesOpen = ref(false)
const revealedCodes = ref<string[] | null>(null)

function revealCodes(codes: string[]) {
  revealedCodes.value = codes
  codesOpen.value = true
}

function dismissCodes() {
  codesOpen.value = false
  revealedCodes.value = null
}

function downloadCodes() {
  if (!revealedCodes.value) return
  const content = [
    'NNT account recovery codes — each works once.',
    `Account: ${user.value?.email ?? ''}`,
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    '',
    ...revealedCodes.value,
    '',
  ].join('\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'nnt-recovery-codes.txt'
  link.click()
  URL.revokeObjectURL(url)
}

async function regenerateCodes() {
  busy.value = 'recovery'
  try {
    const { recoveryCodes } = await $fetch('/api/account/mfa/recovery-codes', { method: 'POST' })
    revealCodes(recoveryCodes)
    await refresh()
  }
  catch (error) {
    fail(error, 'Could not generate recovery codes')
  }
  finally {
    busy.value = null
  }
}

// ── Passkeys ────────────────────────────────────────────────────────────────

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

// ── Removal ─────────────────────────────────────────────────────────────────

const removalOpen = ref(false)
const pendingRemoval = ref<{ id: string, label: string } | null>(null)

function askRemove(id: string, label: string) {
  pendingRemoval.value = { id, label }
  removalOpen.value = true
}

function closeRemoval() {
  removalOpen.value = false
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

// ── Shared helpers ──────────────────────────────────────────────────────────

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
</script>
