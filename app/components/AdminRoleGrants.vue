<template>
  <UPageCard
    title="Roles"
    icon="i-lucide-shield"
    description="Changes are staged here and applied together when you save. They reach privileged surfaces within 15 minutes — pair with force-logout for instant effect."
  >
    <div class="flex flex-col gap-3">
      <!-- One grant per row: identity + status on the first line, the
           editable fields beneath, provenance last. -->
      <div
        v-for="(row, i) in rows"
        :key="row.role"
        class="rounded-md border p-3 flex flex-col gap-2"
        :class="row.status === 'removed' ? 'border-error/40 bg-error/5' : row.status === 'added' ? 'border-success/40' : 'border-default'"
      >
        <div class="flex items-center gap-2">
          <UBadge
            :color="row.expired ? 'error' : 'primary'"
            variant="subtle"
            :class="row.status === 'removed' ? 'line-through opacity-60' : ''"
          >
            {{ row.role }}
          </UBadge>
          <UBadge
            v-if="row.expired && row.status !== 'removed'"
            color="error"
            variant="outline"
            size="sm"
          >
            expired {{ shortDate(row.expiresAt!) }}
          </UBadge>
          <UBadge
            v-if="statusChip(row)"
            :color="row.status === 'removed' ? 'error' : 'success'"
            variant="soft"
            size="sm"
          >
            {{ statusChip(row) }}
          </UBadge>
          <span class="flex-1" />
          <UButton
            v-if="row.status === 'removed'"
            variant="ghost"
            color="neutral"
            size="xs"
            icon="i-lucide-undo-2"
            @click="undoRemove(i)"
          >
            Keep it
          </UButton>
          <UButton
            v-else
            variant="ghost"
            color="error"
            size="xs"
            icon="i-lucide-trash-2"
            :aria-label="`Remove ${row.role}`"
            @click="markRemoved(i)"
          />
        </div>

        <div
          v-if="row.status !== 'removed'"
          class="flex flex-wrap items-end gap-2"
        >
          <UFormField
            label="Expires"
            :name="`expiry-${i}`"
            size="sm"
          >
            <USelect
              :model-value="expiryKind(row)"
              :items="expiryChoices"
              size="sm"
              class="w-56"
              @update:model-value="value => setExpiryKind(i, value as string)"
            />
          </UFormField>
          <UFormField
            v-if="expiryKind(row) === 'custom'"
            label="Date"
            :name="`date-${i}`"
            size="sm"
          >
            <UInputDate
              :model-value="toCalendarDate(row.expiresAt)"
              :min-value="today"
              size="sm"
              @update:model-value="value => setCustomDate(i, value)"
            >
              <template #trailing>
                <UPopover :content="{ align: 'end' }">
                  <UButton
                    variant="link"
                    color="neutral"
                    size="xs"
                    icon="i-lucide-calendar"
                    aria-label="Pick a date from the calendar"
                  />
                  <template #content>
                    <UCalendar
                      :model-value="toCalendarDate(row.expiresAt)"
                      :min-value="today"
                      class="p-2"
                      @update:model-value="value => setCustomDate(i, value as CalendarDate)"
                    />
                  </template>
                </UPopover>
              </template>
            </UInputDate>
          </UFormField>
          <UFormField
            label="Note"
            :name="`note-${i}`"
            size="sm"
            class="flex-1 min-w-40"
          >
            <UInput
              v-model="row.note"
              placeholder="Why they hold it (optional)"
              size="sm"
              class="w-full"
            />
          </UFormField>
        </div>

        <p
          v-if="row.grantedAt"
          class="text-xs text-muted"
        >
          Granted {{ shortDate(row.grantedAt) }}{{ row.expired && row.status !== 'removed' ? ' — pick a new expiry to renew it' : '' }}
        </p>
      </div>

      <p
        v-if="!rows.length"
        class="text-sm text-muted"
      >
        No roles — this account can log in everywhere but administer nothing.
      </p>

      <!--
      Definitions only (ADR-0014): an undefined role cannot be granted.
      -->
      <div class="flex flex-wrap gap-2 items-center">
        <USelectMenu
          v-model="pickedDefinition"
          :items="definitionItems"
          placeholder="Add a role…"
          icon="i-lucide-shield-plus"
          class="w-64"
          @update:model-value="addFromDefinition"
        />
        <ULink
          to="/admin/roles"
          class="text-xs text-muted hover:text-primary"
        >
          Missing a role? Define it first
        </ULink>
      </div>

      <!-- Staged-changes bar -->
      <UAlert
        v-if="dirty"
        color="warning"
        variant="subtle"
        icon="i-lucide-pencil-line"
        :title="changeSummary"
      >
        <template #actions>
          <UButton
            size="sm"
            :loading="saving"
            @click="save"
          >
            Save changes
          </UButton>
          <UButton
            size="sm"
            variant="ghost"
            color="neutral"
            @click="discard"
          >
            Discard
          </UButton>
        </template>
      </UAlert>
    </div>
  </UPageCard>
</template>

<script lang="ts" setup>
import { CalendarDate, today as todayIn, getLocalTimeZone } from '@internationalized/date'

interface ServerGrant {
  role: string
  expiresAt: number | null
  grantedAt: number | null
  grantedBy: string | null
  note: string | null
  expired: boolean
}

const props = defineProps<{
  userId: string
  grants: ServerGrant[]
}>()

const emit = defineEmits<{ saved: [] }>()

const toast = useToast()

interface Row {
  role: string
  expiresAt: number | null
  note: string | null
  expired: boolean
  grantedAt: number | null
  status: 'unchanged' | 'added' | 'edited' | 'removed'
}

const rows = ref<Row[]>([])

function reset() {
  rows.value = props.grants.map(g => ({
    role: g.role,
    expiresAt: g.expiresAt,
    note: g.note,
    expired: g.expired,
    grantedAt: g.grantedAt,
    status: 'unchanged',
  }))
}
watch(() => props.grants, reset, { immediate: true, deep: true })

// Edits are detected against the server rows so toggling a value back to
// what it was clears the flag.
const originals = computed(() => new Map(props.grants.map(g => [g.role, g])))
watch(rows, () => {
  for (const row of rows.value) {
    if (row.status === 'added' || row.status === 'removed') continue
    const original = originals.value.get(row.role)
    row.status = original && (original.expiresAt !== row.expiresAt || (original.note ?? '') !== (row.note ?? ''))
      ? 'edited'
      : 'unchanged'
  }
}, { deep: true })

const dirty = computed(() => rows.value.some(r => r.status !== 'unchanged'))

const changeSummary = computed(() => {
  const counts = { added: 0, edited: 0, removed: 0 }
  for (const row of rows.value) if (row.status !== 'unchanged') counts[row.status]++
  const parts = []
  if (counts.added) parts.push(`${counts.added} to grant`)
  if (counts.edited) parts.push(`${counts.edited} to update`)
  if (counts.removed) parts.push(`${counts.removed} to remove`)
  return `Unsaved role changes: ${parts.join(', ')}.`
})

function statusChip(row: Row): string | null {
  switch (row.status) {
    case 'added': return 'new'
    case 'edited': return 'edited'
    case 'removed': return 'will be removed'
    default: return null
  }
}

// ── Expiry ──────────────────────────────────────────────────────────────────

// Must match nextCommitteeYearEnd in server/utils/rolesConfig.ts, or a
// committee-year expiry will not round-trip through the select.
const committeeYearEnd = computed(() => {
  const now = new Date()
  const candidate = Date.UTC(now.getUTCFullYear(), 6, 31, 23, 59, 59, 999)
  return candidate > now.getTime()
    ? candidate
    : Date.UTC(now.getUTCFullYear() + 1, 6, 31, 23, 59, 59, 999)
})

const expiryChoices = computed(() => [
  { label: 'Never (permanent)', value: 'permanent' },
  { label: `End of committee year (31 Jul ${new Date(committeeYearEnd.value).getUTCFullYear()})`, value: 'committee-year' },
  { label: 'A date I pick…', value: 'custom' },
])

function expiryKind(row: Row): string {
  if (row.expiresAt === null) return 'permanent'
  if (row.expiresAt === committeeYearEnd.value) return 'committee-year'
  return 'custom'
}

function setExpiryKind(index: number, kind: string) {
  const row = rows.value[index]!
  if (kind === 'permanent') row.expiresAt = null
  else if (kind === 'committee-year') row.expiresAt = committeeYearEnd.value
  // 'custom': seed with something editable so the date field appears.
  else if (row.expiresAt === null || row.expiresAt === committeeYearEnd.value) {
    row.expiresAt = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 30, 23, 59, 59, 999)
  }
}

const today = todayIn(getLocalTimeZone())

// CalendarDate ⇄ epoch ms (expiries land at 23:59:59.999 UTC on the chosen
// day, same instant the server's committee-year default uses).
function toCalendarDate(expiresAt: number | null): CalendarDate | undefined {
  if (expiresAt === null) return undefined
  const date = new Date(expiresAt)
  return new CalendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function setCustomDate(index: number, value: unknown) {
  if (!(value instanceof CalendarDate)) return
  rows.value[index]!.expiresAt = Date.UTC(value.year, value.month - 1, value.day, 23, 59, 59, 999)
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Add / remove ────────────────────────────────────────────────────────────

interface Definition {
  id: string
  namespace: string
  role: string
  description: string
  defaultExpiresAt: number | null
}

const { data: definitionsData } = await useFetch<{ definitions: Definition[] }>('/api/role-definitions')

const pickedDefinition = ref<{ label: string, value: string, description: string } | undefined>()

const definitionItems = computed(() => (definitionsData.value?.definitions ?? [])
  .filter(d => !rows.value.some(r => r.role === `${d.namespace}:${d.role}` && r.status !== 'removed'))
  .map(d => ({
    label: `${d.namespace}:${d.role}`,
    value: d.id,
    // Shown as the option hint by USelectMenu.
    description: d.description,
  })))

function appendRole(role: string, expiresAt: number | null) {
  // Re-adding something staged for removal just un-removes it.
  const removed = rows.value.findIndex(r => r.role === role && r.status === 'removed')
  if (removed !== -1) return undoRemove(removed)
  if (rows.value.some(r => r.role === role)) return

  rows.value.push({ role, expiresAt, note: null, expired: false, grantedAt: null, status: 'added' })
}

function addFromDefinition(picked: { value: string } | undefined) {
  if (!picked) return
  const definition = (definitionsData.value?.definitions ?? []).find(d => d.id === picked.value)
  if (definition) appendRole(`${definition.namespace}:${definition.role}`, definition.defaultExpiresAt)
  // Reset AFTER the v-model write lands, or the picker keeps the label.
  nextTick(() => (pickedDefinition.value = undefined))
}

function markRemoved(index: number) {
  const row = rows.value[index]!
  // A never-saved row can just vanish; a real grant stays visible so the
  // removal is reviewable (and undoable) before save.
  if (row.status === 'added') rows.value.splice(index, 1)
  else row.status = 'removed'
}

function undoRemove(index: number) {
  const row = rows.value[index]!
  const original = originals.value.get(row.role)
  row.status = original && (original.expiresAt !== row.expiresAt || (original.note ?? '') !== (row.note ?? ''))
    ? 'edited'
    : 'unchanged'
}

// ── Save ────────────────────────────────────────────────────────────────────

const saving = ref(false)

function discard() {
  reset()
}

async function save() {
  saving.value = true
  try {
    await $fetch(`/api/users/${props.userId}/roles`, {
      method: 'PUT',
      body: {
        roles: rows.value
          .filter(r => r.status !== 'removed')
          .map(r => ({ role: r.role, expiresAt: r.expiresAt, note: r.note || null })),
      },
    })
    emit('saved')
    toast.add({ title: 'Roles saved', color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not save roles'), color: 'error' })
  }
  finally {
    saving.value = false
  }
}
</script>
