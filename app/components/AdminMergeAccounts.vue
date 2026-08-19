<template>
  <UPageCard
    title="Merge accounts"
    icon="i-lucide-merge"
    description="Absorb a duplicate account into this one. This account keeps its identity and gains the other's roles, history and bookings; the other account is erased."
  >
    <div class="flex flex-col gap-3">
      <UFormField
        label="Account to absorb"
        help="Usually the older duplicate: its bookings and roles move here"
      >
        <USelectMenu
          v-model="picked"
          v-model:search-term="searchTerm"
          :items="candidates"
          :loading="searching"
          ignore-filter
          placeholder="Search by email or name…"
          icon="i-lucide-user-round-search"
          class="w-full"
        />
      </UFormField>

      <UButton
        variant="outline"
        color="warning"
        icon="i-lucide-merge"
        class="self-start"
        :disabled="!picked"
        :loading="planning"
        @click="openPlan"
      >
        Review merge…
      </UButton>
      <p class="text-xs text-muted">
        Merging the other way? Do it from
        <ULink
          v-if="picked"
          :to="`/admin/users/${picked.value}`"
          class="underline"
        >the other account's page</ULink>
        <template v-else>
          the other account's page
        </template>.
      </p>
    </div>

    <!-- ── Plan + confirm ─────────────────────────────────────────────── -->
    <UModal
      v-model:open="planOpen"
      title="Merge accounts"
      :description="plan
        ? `${plan.loser.email} is absorbed into ${plan.winner.email}. The absorbed account is erased: this cannot be undone.`
        : ''"
    >
      <template #body>
        <div
          v-if="plan"
          class="flex flex-col gap-4"
        >
          <UAlert
            v-for="warning in plan.warnings"
            :key="warning"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="warning"
          />

          <div>
            <h4 class="mb-1 text-sm font-medium">
              Roles after the merge
            </h4>
            <ul class="flex flex-col gap-1 text-sm">
              <li
                v-for="role in plan.roles"
                :key="role.role"
                class="flex items-center gap-2"
              >
                <UBadge
                  color="primary"
                  variant="subtle"
                  size="sm"
                >
                  {{ role.role }}
                </UBadge>
                <span class="text-muted">{{ roleOutcomeLabel(role) }}</span>
              </li>
              <li
                v-if="!plan.roles.length"
                class="text-muted"
              >
                None on either account.
              </li>
            </ul>
          </div>

          <div>
            <h4 class="mb-1 text-sm font-medium">
              What moves across the sites
            </h4>
            <ul class="flex flex-col gap-1 text-sm text-muted">
              <li
                v-for="app in plan.apps"
                :key="app.app"
              >
                <template v-if="app.ok">
                  {{ app.app }}: {{ appCountsLabel(app) }}
                </template>
                <span
                  v-else
                  class="text-error"
                >{{ app.app }} is unreachable, so fix that before merging</span>
              </li>
              <li v-if="plan.gains.password || plan.gains.google || plan.gains.verified">
                This account gains:
                {{ [plan.gains.password ? 'a password' : '', plan.gains.google ? 'a Google link' : '', plan.gains.verified ? 'a verified email' : ''].filter(Boolean).join(', ') }}.
              </li>
              <li v-if="plan.legacyIds.length">
                {{ plan.legacyIds.length }} legacy {{ plan.legacyIds.length === 1 ? 'id' : 'ids' }} move too.
              </li>
            </ul>
          </div>

          <UAlert
            v-if="result && !result.complete"
            color="error"
            icon="i-lucide-alert-circle"
            title="Merge incomplete"
            :description="`Failed: ${result.plan.apps.filter(a => !a.ok).map(a => a.app).join(', ')}. Nothing central changed: re-run once the app is back.`"
          />

          <UFormField
            :label="`Type the absorbed account's email (${plan.loser.email}) to confirm`"
            name="confirmEmail"
          >
            <UInput
              v-model="confirmEmail"
              type="email"
              class="w-full"
            />
          </UFormField>

          <div class="flex gap-2">
            <UButton
              color="error"
              :loading="merging"
              :disabled="confirmEmail.toLowerCase() !== plan.loser.email || plan.apps.some(a => !a.ok)"
              @click="commit"
            >
              Merge accounts
            </UButton>
            <UButton
              variant="ghost"
              color="neutral"
              @click="closePlan"
            >
              Cancel
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </UPageCard>
</template>

<script lang="ts" setup>
import type { MergePlan, MergeResult } from '~~/server/utils/mergeUsers'

const props = defineProps<{ userId: string }>()
const emit = defineEmits<{ merged: [] }>()

const toast = useToast()

// ── Candidate search (server-side, the admin list API) ─────────────────────

const searchTerm = ref('')
const searching = ref(false)
const picked = ref<{ label: string, value: string, description?: string } | undefined>()
const candidates = ref<{ label: string, value: string, description?: string }[]>([])

interface ListedUser { id: string, email: string, name: string }

watch(searchTerm, async (q) => {
  if (q.trim().length < 2) return
  searching.value = true
  try {
    const result = await $fetch<{ users: ListedUser[] }>('/api/users', { query: { q: q.trim() } })
    candidates.value = result.users
      .filter(u => u.id !== props.userId)
      .map(u => ({ label: u.email, value: u.id, description: u.name }))
  }
  catch {
    // Search failures just leave the previous candidates in place.
  }
  finally {
    searching.value = false
  }
})

// ── Dry-run plan ────────────────────────────────────────────────────────────

const planOpen = ref(false)
const planning = ref(false)
const plan = ref<MergePlan | null>(null)
const confirmEmail = ref('')
const result = ref<MergeResult | null>(null)

async function openPlan() {
  if (!picked.value) return
  planning.value = true
  try {
    const dry = await $fetch<MergeResult>(`/api/users/${props.userId}/merge`, {
      method: 'POST',
      body: { loserId: picked.value.value, dryRun: true },
    })
    plan.value = dry.plan
    result.value = null
    confirmEmail.value = ''
    planOpen.value = true
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not plan the merge'), color: 'error' })
  }
  finally {
    planning.value = false
  }
}

function closePlan() {
  planOpen.value = false
}

function roleOutcomeLabel(role: MergePlan['roles'][number]): string {
  const expiry = role.expiresAt === null ? 'permanent' : `until ${formatDate(role.expiresAt)}`
  switch (role.outcome) {
    case 'moved': return `moves from the absorbed account (${expiry})`
    case 'conflict-earliest-expiry': return `held by both: earliest expiry kept (${expiry})`
    default: return `already here (${expiry})`
  }
}

function appCountsLabel(app: MergePlan['apps'][number]): string {
  const counts = app.data?.counts ?? {}
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`)
  return parts.length ? parts.join(', ') : 'nothing to move'
}

// ── Commit ──────────────────────────────────────────────────────────────────

const merging = ref(false)

async function commit() {
  if (!picked.value || !plan.value) return
  merging.value = true
  try {
    result.value = await $fetch<MergeResult>(`/api/users/${props.userId}/merge`, {
      method: 'POST',
      body: { loserId: picked.value.value, confirmEmail: confirmEmail.value },
    })
    if (result.value.complete) {
      planOpen.value = false
      picked.value = undefined
      toast.add({ title: 'Accounts merged', color: 'success' })
      emit('merged')
    }
    // Incomplete: the alert in the modal explains; leave it open for re-run.
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Merge failed'), color: 'error' })
  }
  finally {
    merging.value = false
  }
}
</script>
