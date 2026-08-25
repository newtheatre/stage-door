<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <div class="flex flex-wrap items-center gap-2">
      <p class="text-sm text-muted flex-1 min-w-64">
        Definitions drive the role picker on user pages, with the default
        expiry pre-filled. A role must be defined before it can be granted
        (ADR-0014). They are <strong>read-only here</strong>: every one comes
        from its app's manifest, so adding or changing a role is a deploy of
        the app that owns it and nothing else (ADR-0024). A withdrawn one is a
        role its app has stopped reading: it cannot be granted again, and its
        existing holders are untouched until someone revokes them.
      </p>
    </div>

    <UAlert
      v-if="suspects.length"
      color="error"
      icon="i-lucide-triangle-alert"
      title="Some grants do nothing"
    >
      <template #description>
        <p class="mb-2">
          These are held by real accounts but match nothing any app reads, so
          they confer no access and never will. Revoke them, or define the role
          if it was meant to work.
        </p>
        <ul class="flex flex-col gap-1">
          <li
            v-for="suspect in suspects"
            :key="suspect.role"
          >
            <ULink :to="`/admin?role=${encodeURIComponent(suspect.role)}`">
              <code>{{ suspect.role }}</code>
            </ULink>
            ({{ suspect.holders }} {{ suspect.holders === 1 ? 'holder' : 'holders' }}).
            {{ suspect.explanation }}
          </li>
        </ul>
      </template>
    </UAlert>

    <UAlert
      v-if="staleRules.length"
      color="error"
      icon="i-lucide-clock-alert"
      title="Eligibility answers are out of date"
    >
      <template #description>
        <p class="mb-2">
          Nobody's access has changed: the last good answer stays in force, and
          a rule never answered enforces nothing. Check rehearsal and the
          training API token, then re-run the eligibility snapshot.
        </p>
        <ul class="flex flex-col gap-1">
          <li
            v-for="rule in staleRules"
            :key="rule.ruleKey"
          >
            <code>{{ rule.ruleKey }}</code>:
            {{ rule.lastSuccessAt ? `last answered ${formatDateTime(rule.lastSuccessAt)}` : 'never answered' }}<span v-if="rule.lastError">. {{ rule.lastError }}</span>
          </li>
        </ul>
      </template>
    </UAlert>

    <UTable
      :data="tableRows"
      :columns="columns"
      :loading="pending"
    >
      <template #role-cell="{ row }">
        <div class="flex items-center gap-2">
          <UBadge
            :color="row.original.definition.withdrawnAt ? 'neutral' : 'primary'"
            variant="subtle"
            :class="row.original.definition.withdrawnAt && 'line-through'"
          >
            {{ row.original.role }}
          </UBadge>
          <UBadge
            v-if="row.original.definition.withdrawnAt"
            color="warning"
            variant="subtle"
            size="sm"
          >
            withdrawn
          </UBadge>
          <UIcon
            v-else-if="row.original.definition.source === 'manifest'"
            name="i-lucide-boxes"
            class="text-muted"
            :aria-label="`Declared by its app, manifest ${row.original.definition.manifestVersion}`"
          />
          <UBadge
            v-if="row.original.definition.requiresEligibilityKey"
            :color="row.original.definition.eligibilityMode === 'enforcing' ? 'warning' : 'neutral'"
            variant="subtle"
            size="sm"
            :title="`Training rule ${row.original.definition.requiresEligibilityKey}`"
          >
            {{ row.original.definition.eligibilityMode }} training
          </UBadge>
        </div>
      </template>

      <template #expiry-cell="{ row }">
        <span class="text-sm">{{ row.original.expiry }}</span>
      </template>

      <template #holders-cell="{ row }">
        <UButton
          v-if="row.original.holders > 0"
          variant="link"
          size="sm"
          class="p-0"
          :to="`/admin?role=${encodeURIComponent(row.original.role)}`"
        >
          {{ row.original.holders }} {{ row.original.holders === 1 ? 'holder' : 'holders' }}
        </UButton>
        <span
          v-else
          class="text-sm text-muted"
        >none</span>
      </template>
    </UTable>

    <p
      v-if="!pending && !tableRows.length"
      class="text-sm text-muted"
    >
      No definitions yet. They arrive when an app's manifest is synced.
    </p>
  </UContainer>
</template>

<script lang="ts" setup>
definePageMeta({
  middleware: 'admin',
  title: 'Admin: role definitions',
})

interface Definition {
  id: string
  namespace: string
  role: string
  description: string
  defaultExpiryKind: 'none' | 'committee-year' | 'days'
  defaultExpiryDays: number | null
  defaultExpiresAt: number | null
  holders: number
  source: 'manifest' | 'manual'
  withdrawnAt: number | null
  manifestVersion: string | null
  requiresEligibilityKey: string | null
  eligibilityMode: 'advisory' | 'enforcing'
}

const { data, pending } = await useFetch<{ definitions: Definition[] }>('/api/role-definitions')

// Dormant namespaces are excluded server-side, so anything here is a mistake.
const { data: auditData } = await useFetch('/api/role-audit')
const suspects = computed(() => auditData.value?.suspects ?? [])

const { data: syncData } = await useFetch('/api/eligibility-syncs')
const staleRules = computed(() => (syncData.value?.syncs ?? []).filter(s => s.stale))

const columns = [
  { accessorKey: 'role', header: 'Role' },
  { accessorKey: 'description', header: 'Description', meta: { class: { td: 'max-w-72 truncate text-muted' } } },
  { accessorKey: 'expiry', header: 'Default expiry' },
  { accessorKey: 'holders', header: 'Holders' },
]

const tableRows = computed(() => (data.value?.definitions ?? []).map(d => ({
  role: `${d.namespace}:${d.role}`,
  description: d.description,
  expiry: expiryLabel(d),
  holders: d.holders,
  definition: d,
})))

function expiryLabel(definition: Definition): string {
  if (definition.defaultExpiryKind === 'committee-year') return 'End of committee year'
  if (definition.defaultExpiryKind === 'days') return `${definition.defaultExpiryDays} days`
  return 'Permanent'
}
</script>
