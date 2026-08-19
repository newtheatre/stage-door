<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <div
      v-if="user"
      class="flex flex-col gap-4"
    >
      <div class="flex items-center gap-3">
        <UButton
          to="/admin"
          variant="ghost"
          icon="i-lucide-arrow-left"
          size="sm"
        >
          All users
        </UButton>
        <h1 class="text-xl font-bold">
          {{ user.name }}
        </h1>
        <UBadge
          v-if="user.disabled"
          color="error"
          variant="subtle"
        >
          Disabled
        </UBadge>
        <UBadge
          v-else-if="user.guest"
          color="neutral"
          variant="subtle"
        >
          Guest (shadow)
        </UBadge>
        <UBadge
          v-else-if="user.verified"
          color="success"
          variant="subtle"
        >
          Verified
        </UBadge>
        <UBadge
          v-else
          color="warning"
          variant="subtle"
        >
          Unverified
        </UBadge>
      </div>

      <div class="grid md:grid-cols-2 gap-4">
        <UPageCard
          title="Identity"
          icon="i-lucide-id-card"
        >
          <UForm
            :state="profileForm"
            class="flex flex-col gap-4"
            @submit="saveProfile"
          >
            <UFormField
              label="Name"
              name="name"
            >
              <UInput
                v-model="profileForm.name"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Email"
              name="email"
              help="Changing this resets verification and emails a new link"
            >
              <UInput
                v-model="profileForm.email"
                type="email"
                class="w-full"
              />
            </UFormField>
            <UButton
              type="submit"
              :loading="saving"
              class="self-start"
            >
              Save
            </UButton>
          </UForm>

          <USeparator class="my-4" />

          <dl class="text-sm grid grid-cols-2 gap-y-1">
            <dt class="text-muted">
              Login methods
            </dt>
            <dd>{{ loginMethods }}</dd>
            <dt class="text-muted">
              Last login
            </dt>
            <dd>{{ user.lastLogin ? formatDateTime(user.lastLogin) : 'never' }}</dd>
            <dt class="text-muted">
              Created
            </dt>
            <dd>{{ formatDate(user.createdAt) }}</dd>
            <dt class="text-muted">
              Legacy ids
            </dt>
            <dd>{{ user.legacyIds?.length ? user.legacyIds.map((l: { source: string, legacyId: string }) => `${l.source}:${l.legacyId}`).join(', ') : '—' }}</dd>
          </dl>
        </UPageCard>

        <AdminRoleGrants
          v-if="user"
          :user-id="id"
          :grants="user.grants"
          @saved="refresh"
        />

        <UPageCard
          title="Google link"
          icon="i-simple-icons-google"
        >
          <div class="flex flex-col gap-3 text-sm">
            <p v-if="user.googleLinked">
              An NNT Google account is linked.
            </p>
            <p v-else-if="user.pendingGoogleEmail">
              Pending link: the next Google sign-in with
              <strong>{{ user.pendingGoogleEmail }}</strong> attaches to this account.
            </p>
            <p
              v-else
              class="text-muted"
            >
              No Google account linked.
            </p>

            <div class="flex flex-wrap gap-2">
              <UButton
                v-if="user.googleLinked"
                variant="outline"
                color="neutral"
                size="sm"
                @click="unlinkGoogle"
              >
                Unlink Google
              </UButton>
              <template v-else>
                <UInput
                  v-model="pendingEmail"
                  :placeholder="`name@newtheatre.org.uk`"
                  size="sm"
                  class="w-56"
                />
                <UButton
                  variant="outline"
                  size="sm"
                  @click="setPendingGoogle"
                >
                  Set pending link
                </UButton>
                <UButton
                  v-if="user.pendingGoogleEmail"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  @click="clearPendingGoogle"
                >
                  Clear
                </UButton>
              </template>
            </div>
          </div>
        </UPageCard>

        <UPageCard
          title="Two-step sign-in"
          icon="i-lucide-shield-check"
        >
          <div class="flex flex-col gap-3 text-sm">
            <p v-if="user.mfa.factors.length">
              Enrolled:
              <strong>{{ user.mfa.factors.includes('totp') ? 'authenticator app' : '' }}{{ user.mfa.factors.length === 2 ? ', ' : '' }}{{ user.mfa.passkeys ? `${user.mfa.passkeys} passkey${user.mfa.passkeys === 1 ? '' : 's'}` : '' }}</strong>.
              {{ user.mfa.recoveryCodesRemaining }} recovery
              {{ user.mfa.recoveryCodesRemaining === 1 ? 'code' : 'codes' }} unused.
            </p>
            <p
              v-else-if="user.mfa.required"
              class="text-warning"
            >
              Required but not set up — this account holds an admin role and
              signs in with a password. Admin tools stay closed until they
              enrol.
            </p>
            <p
              v-else
              class="text-muted"
            >
              Not set up (not required for this account).
            </p>

            <UButton
              v-if="user.mfa.factors.length"
              variant="outline"
              color="error"
              size="sm"
              class="self-start"
              @click="mfaReset"
            >
              Reset second factors
            </UButton>
            <p
              v-if="user.mfa.factors.length"
              class="text-xs text-muted"
            >
              The "lost my phone" path. Verify who you are talking to out of
              band first — this removes their protection until they re-enrol.
            </p>

            <template v-if="isWorkspaceAddress && user.hasPassword">
              <USeparator />
              <p class="text-warning">
                This is an <code>@newtheatre.org.uk</code> address with a
                password set. Workspace accounts sign in with Google only;
                once the account is linked, clear the password so the rule is
                enforced by data as well as code.
              </p>
              <UButton
                variant="outline"
                color="warning"
                size="sm"
                class="self-start"
                @click="clearPassword"
              >
                Clear password
              </UButton>
            </template>
          </div>
        </UPageCard>

        <AdminMergeAccounts
          :user-id="id"
          @merged="refresh"
        />

        <UPageCard
          title="Data & GDPR"
          icon="i-lucide-file-lock"
        >
          <div class="flex flex-col gap-2">
            <UButton
              variant="outline"
              icon="i-lucide-download"
              block
              :to="`/api/users/${id}/export`"
              external
            >
              Download subject-access export
            </UButton>
            <UButton
              variant="outline"
              color="error"
              icon="i-lucide-eraser"
              block
              @click="openErase"
            >
              Erase (anonymise) account…
            </UButton>
            <p class="text-xs text-muted">
              Erasure is irreversible. Verify the requester's identity first —
              see the operations runbook. Bookings survive anonymously.
            </p>
          </div>
        </UPageCard>

        <UPageCard
          title="Security operations"
          icon="i-lucide-siren"
        >
          <div class="flex flex-col gap-2">
            <UButton
              variant="outline"
              icon="i-lucide-mail"
              block
              @click="adminReset"
            >
              Send password reset (24 h link)
            </UButton>
            <UButton
              variant="outline"
              color="warning"
              icon="i-lucide-log-out"
              block
              @click="forceLogout"
            >
              Force logout everywhere
            </UButton>
            <UButton
              v-if="!user.disabled"
              variant="outline"
              color="error"
              icon="i-lucide-user-round-x"
              block
              @click="disable"
            >
              Disable account
            </UButton>
            <UButton
              v-else
              variant="outline"
              color="success"
              icon="i-lucide-user-round-check"
              block
              @click="enable"
            >
              Re-enable account
            </UButton>
          </div>
        </UPageCard>
      </div>

      <UModal
        v-model:open="eraseOpen"
        title="Erase this account"
        description="Irreversible. The identity is anonymised here and in every app; bookings are kept without personal details."
      >
        <template #body>
          <div class="flex flex-col gap-4">
            <UFormField
              :label="`Type the account's email (${user.email}) to confirm`"
              name="confirmEmail"
            >
              <UInput
                v-model="eraseConfirm"
                class="w-full"
              />
            </UFormField>
            <UAlert
              v-if="eraseResult && !eraseResult.complete"
              color="warning"
              icon="i-lucide-alert-triangle"
              title="Erasure incomplete — some app hooks failed"
              :description="`Failed: ${eraseResult.hooks.filter(h => !h.ok).map(h => h.app).join(', ')}. Re-run to retry.`"
            />
            <UButton
              color="error"
              :loading="erasing"
              :disabled="eraseConfirm.toLowerCase() !== user.email"
              block
              @click="eraseAccount"
            >
              Erase permanently
            </UButton>
          </div>
        </template>
      </UModal>
    </div>
  </UContainer>
</template>

<script lang="ts" setup>
definePageMeta({
  middleware: 'admin',
  title: 'Admin — user',
})

const route = useRoute()
const toast = useToast()
const id = route.params.id as string

interface AdminUserDetail {
  id: string
  email: string
  name: string
  verified: boolean
  guest: boolean
  hasPassword: boolean
  googleLinked: boolean
  pendingGoogleEmail: string | null
  disabled: boolean
  createdAt: number
  lastLogin: number | null
  roles: string[]
  grants: { role: string, expiresAt: number | null, grantedAt: number | null, grantedBy: string | null, note: string | null, expired: boolean }[]
  legacyIds: { source: string, legacyId: string }[]
  mfa: { required: boolean, factors: string[], passkeys: number, recoveryCodesRemaining: number }
}

// Dynamic URL defeats Nitro's route typing — assert the shape instead.
const { data, refresh } = await useFetch<{ user: AdminUserDetail }>(`/api/users/${id}`)
const user = computed(() => data.value?.user)

const profileForm = reactive({ name: '', email: '' })
const pendingEmail = ref('')
watchEffect(() => {
  if (user.value) {
    profileForm.name = user.value.name
    profileForm.email = user.value.email
  }
})

const isWorkspaceAddress = computed(() => user.value?.email.endsWith('@newtheatre.org.uk') ?? false)

const loginMethods = computed(() => {
  const methods = []
  if (user.value?.hasPassword) methods.push('password')
  if (user.value?.googleLinked) methods.push('Google')
  return methods.join(' + ') || 'none (shadow account)'
})

const saving = ref(false)

async function act(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    await refresh()
    toast.add({ title: label, color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Action failed'), color: 'error' })
  }
}

async function saveProfile() {
  saving.value = true
  await act('Profile saved', () =>
    $fetch(`/api/users/${id}`, { method: 'PUT', body: { ...profileForm } }))
  saving.value = false
}

const eraseOpen = ref(false)

function openErase() {
  eraseOpen.value = true
}
const eraseConfirm = ref('')
const erasing = ref(false)
const eraseResult = ref<{ complete: boolean, hooks: { app: string, ok: boolean }[] } | null>(null)

async function eraseAccount() {
  erasing.value = true
  try {
    eraseResult.value = await $fetch<{ complete: boolean, hooks: { app: string, ok: boolean }[] }>(
      `/api/users/${id}/erase`,
      { method: 'POST', body: { confirmEmail: eraseConfirm.value } },
    )
    if (eraseResult.value.complete) {
      eraseOpen.value = false
      toast.add({ title: 'Account erased', color: 'success' })
    }
    await refresh()
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Erasure failed'), color: 'error' })
  }
  finally {
    erasing.value = false
  }
}

const adminReset = () => act('Reset email sent', () =>
  $fetch(`/api/users/${id}/reset-password`, { method: 'POST' }))
const forceLogout = () => act('Sessions invalidated', () =>
  $fetch(`/api/users/${id}/force-logout`, { method: 'POST' }))
const disable = () => act('Account disabled', () =>
  $fetch(`/api/users/${id}/disable`, { method: 'POST' }))
const enable = () => act('Account re-enabled', () =>
  $fetch(`/api/users/${id}/enable`, { method: 'POST' }))
const unlinkGoogle = () => act('Google unlinked', () =>
  $fetch(`/api/users/${id}/unlink-google`, { method: 'POST' }))
const setPendingGoogle = () => act('Pending link set', () =>
  $fetch(`/api/users/${id}/pending-google`, { method: 'PUT', body: { email: pendingEmail.value } }))
const clearPendingGoogle = () => act('Pending link cleared', () =>
  $fetch(`/api/users/${id}/pending-google`, { method: 'PUT', body: { email: null } }))
const mfaReset = () => act('Second factors cleared', () =>
  $fetch(`/api/users/${id}/mfa-reset`, { method: 'POST' }))
const clearPassword = () => act('Password cleared — Google sign-in only', () =>
  $fetch(`/api/users/${id}/clear-password`, { method: 'POST' }))
</script>
