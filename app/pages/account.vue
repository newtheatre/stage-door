<template>
  <UContainer class="flex flex-col items-center gap-4 p-4 flex-1 max-w-2xl">
    <UAlert
      v-if="banner"
      :color="banner.color"
      :icon="banner.icon"
      :title="banner.text"
      class="w-full"
    />

    <UTabs
      v-model="tab"
      :items="tabItems"
      class="w-full"
      :unmount-on-hide="false"
    >
      <!-- ── Profile ─────────────────────────────────────────────────── -->
      <template #profile>
        <div class="flex flex-col gap-4 pt-4">
          <UPageCard
            class="w-full"
            title="Profile"
            icon="i-lucide-circle-user-round"
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
                  autocomplete="name"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="Email"
                name="email"
                :help="profile?.verified ? 'Verified' : 'Not yet verified: check your inbox'"
              >
                <UInput
                  v-model="profileForm.email"
                  type="email"
                  autocomplete="email"
                  class="w-full"
                />
              </UFormField>
              <p
                v-if="emailChanged"
                class="text-sm text-warning"
              >
                Changing your email sends a new verification link to the new address.
              </p>
              <UButton
                type="submit"
                :loading="savingProfile"
                class="self-start"
              >
                Save profile
              </UButton>
            </UForm>
          </UPageCard>
        </div>
      </template>

      <!-- ── Sign-in & security ──────────────────────────────────────── -->
      <template #security>
        <div class="flex flex-col gap-4 pt-4">
          <UPageCard
            class="w-full"
            :title="profile?.hasPassword ? 'Change password' : 'Set a password'"
            icon="i-lucide-key-round"
            :description="profile?.hasPassword
              ? undefined
              : 'You currently sign in with Google only. Setting a password adds a second way in.'"
          >
            <UForm
              :state="passwordForm"
              :schema="passwordFormSchema"
              class="flex flex-col gap-4"
              @submit="savePassword"
            >
              <UFormField
                v-if="profile?.hasPassword"
                label="Current password"
                name="currentPassword"
              >
                <UInput
                  v-model="passwordForm.currentPassword"
                  type="password"
                  autocomplete="current-password"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="New password"
                name="password"
                help="At least 8 characters, with an upper- and lowercase letter and a number"
              >
                <UInput
                  v-model="passwordForm.password"
                  type="password"
                  autocomplete="new-password"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="Confirm new password"
                name="confirmPassword"
              >
                <UInput
                  v-model="passwordForm.confirmPassword"
                  type="password"
                  autocomplete="new-password"
                  class="w-full"
                />
              </UFormField>
              <UButton
                type="submit"
                :loading="savingPassword"
                class="self-start"
              >
                {{ profile?.hasPassword ? 'Change password' : 'Set password' }}
              </UButton>
            </UForm>
          </UPageCard>

          <AccountMfa />

          <UPageCard
            class="w-full"
            title="NNT Google account"
            icon="i-simple-icons-google"
          >
            <div
              v-if="profile?.googleLinked"
              class="flex flex-col gap-3"
            >
              <p class="text-sm text-muted">
                A <code>@newtheatre.org.uk</code> Google account is connected: you
                can sign in with either method.
              </p>
              <UButton
                variant="outline"
                color="neutral"
                class="self-start"
                :loading="unlinking"
                @click="unlinkGoogle"
              >
                Disconnect Google
              </UButton>
            </div>
            <div
              v-else
              class="flex flex-col gap-3"
            >
              <p class="text-sm text-muted">
                Members with an NNT Workspace account can connect it here and use
                "Sign in with Google" from then on: even if this account uses a
                different email address.
              </p>
              <UButton
                to="/auth/google-link"
                external
                variant="outline"
                class="self-start"
                icon="i-simple-icons-google"
              >
                Connect NNT Google account
              </UButton>
            </div>
          </UPageCard>

          <UPageCard
            class="w-full"
            title="Everywhere else"
            icon="i-lucide-siren"
          >
            <div class="flex flex-col gap-3">
              <p class="text-sm text-muted">
                Suspect someone else has access? Log out every session on every NNT
                site (including this one), then reset your password.
              </p>
              <UButton
                variant="outline"
                color="error"
                class="self-start"
                icon="i-lucide-log-out"
                :loading="loggingOutEverywhere"
                @click="logoutEverywhere"
              >
                Log out everywhere
              </UButton>
            </div>
          </UPageCard>
        </div>
      </template>

      <!-- ── Data & privacy ──────────────────────────────────────────── -->
      <template #data>
        <div class="flex flex-col gap-4 pt-4">
          <UPageCard
            class="w-full"
            title="Your data"
            icon="i-lucide-file-lock"
          >
            <div class="flex flex-col gap-3">
              <p class="text-sm text-muted">
                Download everything the NNT holds about you: your account details
                plus your bookings from each NNT site, or close your account for
                good. Closing removes your personal details everywhere; booking
                records are kept anonymously for the theatre's accounts.
              </p>
              <div class="flex flex-wrap gap-2">
                <UButton
                  to="/api/account/export"
                  external
                  variant="outline"
                  icon="i-lucide-download"
                >
                  Download my data
                </UButton>
                <UButton
                  variant="outline"
                  color="error"
                  icon="i-lucide-eraser"
                  @click="openClose"
                >
                  Close my account…
                </UButton>
              </div>
            </div>
          </UPageCard>
        </div>
      </template>
    </UTabs>

    <UModal
      v-model:open="closeOpen"
      title="Close your account"
      description="This is permanent. Your personal details are removed from every NNT site; anonymous booking records remain."
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            This needs a recent login. If you signed in more than ten minutes ago,
            log out and back in first.
          </p>
          <UFormField
            label="Type your email address to confirm"
            name="confirmEmail"
          >
            <UInput
              v-model="closeForm.confirmEmail"
              type="email"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="profile?.hasPassword"
            label="Your password"
            name="password"
          >
            <UInput
              v-model="closeForm.password"
              type="password"
              autocomplete="current-password"
              class="w-full"
            />
          </UFormField>
          <UButton
            color="error"
            block
            :loading="closing"
            :disabled="closeForm.confirmEmail.toLowerCase() !== profile?.email"
            @click="closeAccount"
          >
            Close my account permanently
          </UButton>
        </div>
      </template>
    </UModal>
  </UContainer>
</template>

<script lang="ts" setup>
import { z } from 'zod'
import type { TabsItem } from '@nuxt/ui'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { fetch: refreshSession, clear } = useUserSession()

definePageMeta({
  middleware: 'auth',
  title: 'Your account',
})

// ── Tabs, synced with ?tab= so /account?tab=security deep-links ────────────

const tabItems: TabsItem[] = [
  { label: 'Profile', icon: 'i-lucide-circle-user-round', value: 'profile', slot: 'profile' },
  { label: 'Sign-in & security', icon: 'i-lucide-shield-check', value: 'security', slot: 'security' },
  { label: 'Data & privacy', icon: 'i-lucide-file-lock', value: 'data', slot: 'data' },
]

const validTab = (value: unknown): value is string => tabItems.some(t => t.value === value)

const tab = computed({
  get: () => validTab(route.query.tab) ? route.query.tab : 'profile',
  set: (value) => {
    router.replace({ query: { ...route.query, tab: value === 'profile' ? undefined : value } })
  },
})

const { data, refresh } = await useFetch('/api/account/profile')
const profile = computed(() => data.value?.profile)

const profileForm = reactive({ name: '', email: '' })
watchEffect(() => {
  if (profile.value) {
    profileForm.name = profile.value.name
    profileForm.email = profile.value.email
  }
})
const emailChanged = computed(() => !!profile.value && profileForm.email.toLowerCase() !== profile.value.email)

// The shared policy plus the confirmation: mistakes surface inline instead
// of as a server 400.
const passwordFormSchema = z.object({
  currentPassword: z.string().optional(),
  password: passwordSchema,
  confirmPassword: z.string(),
}).refine(form => form.password === form.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
})

const passwordForm = reactive({ currentPassword: '', password: '', confirmPassword: '' })

const savingProfile = ref(false)
const savingPassword = ref(false)
const unlinking = ref(false)
const loggingOutEverywhere = ref(false)

const banner = computed(() => {
  switch (route.query.linked === '1' ? 'linked' : route.query.error) {
    case 'linked':
      return { color: 'success' as const, icon: 'i-lucide-badge-check', text: 'Google account connected.' }
    case 'stale-session':
      return { color: 'warning' as const, icon: 'i-lucide-clock-alert', text: 'Connecting Google needs a recent login: log out and back in, then try again.' }
    case 'google-already-linked':
      return { color: 'error' as const, icon: 'i-lucide-alert-circle', text: 'That Google account is already linked to a different NNT account. Contact the IT Manager to sort it out.' }
    case 'google':
      return { color: 'error' as const, icon: 'i-lucide-alert-circle', text: 'Google connection failed. Please try again.' }
    case 'mfa-required':
      return { color: 'warning' as const, icon: 'i-lucide-lock', text: 'Admin tools are locked until you set up two-step sign-in below.' }
    default:
      return undefined
  }
})

async function saveProfile() {
  savingProfile.value = true
  try {
    await $fetch('/api/account/profile', { method: 'PUT', body: { ...profileForm } })
    await Promise.all([refresh(), refreshSession()])
    toast.add({ title: 'Profile saved', color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not save profile'), color: 'error' })
  }
  finally {
    savingProfile.value = false
  }
}

async function savePassword() {
  savingPassword.value = true
  try {
    await $fetch('/api/account/password', {
      method: 'PUT',
      body: {
        password: passwordForm.password,
        ...(profile.value?.hasPassword ? { currentPassword: passwordForm.currentPassword } : {}),
      },
    })
    passwordForm.currentPassword = ''
    passwordForm.password = ''
    passwordForm.confirmPassword = ''
    await Promise.all([refresh(), refreshSession()])
    toast.add({ title: 'Password updated: other sessions have been logged out', color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not change password'), color: 'error' })
  }
  finally {
    savingPassword.value = false
  }
}

async function unlinkGoogle() {
  unlinking.value = true
  try {
    await $fetch('/api/account/unlink-google', { method: 'POST' })
    await Promise.all([refresh(), refreshSession()])
    toast.add({ title: 'Google account disconnected', color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not disconnect Google'), color: 'error' })
  }
  finally {
    unlinking.value = false
  }
}

const closeOpen = ref(false)

function openClose() {
  closeOpen.value = true
}
const closing = ref(false)
const closeForm = reactive({ confirmEmail: '', password: '' })

async function closeAccount() {
  closing.value = true
  try {
    await $fetch('/api/account/erase', {
      method: 'POST',
      body: {
        confirmEmail: closeForm.confirmEmail,
        ...(profile.value?.hasPassword ? { password: closeForm.password } : {}),
      },
    })
    await clear()
    await navigateTo('/login')
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not close your account'), color: 'error' })
    closing.value = false
  }
}

async function logoutEverywhere() {
  loggingOutEverywhere.value = true
  try {
    await $fetch('/api/account/logout-everywhere', { method: 'POST' })
    await clear()
    await navigateTo('/login')
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not log out everywhere'), color: 'error' })
    loggingOutEverywhere.value = false
  }
}
</script>
