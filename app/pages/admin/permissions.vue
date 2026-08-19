<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <p class="text-sm text-muted">
      What each app's roles actually let someone do, as the apps themselves
      declare it (ADR-0018). Use it to answer "who can approve refunds?"
      without reading an app's source.
    </p>

    <UTable
      :data="rows"
      :columns="columns"
      :loading="pending"
    >
      <template #key-cell="{ row }">
        <div class="flex items-center gap-2">
          <UBadge
            :color="row.original.active ? 'primary' : 'neutral'"
            variant="subtle"
          >
            {{ row.original.namespace }}:{{ row.original.key }}
          </UBadge>
          <UBadge
            v-if="!row.original.active"
            color="warning"
            variant="subtle"
            size="sm"
          >
            no longer declared
          </UBadge>
        </div>
      </template>

      <template #roles-cell="{ row }">
        <div
          v-if="row.original.roles.length"
          class="flex flex-wrap gap-1"
        >
          <UButton
            v-for="carrier in row.original.roles"
            :key="carrier.role"
            variant="soft"
            size="xs"
            :color="carrier.withdrawn ? 'neutral' : 'primary'"
            :to="`/admin?role=${encodeURIComponent(carrier.role)}`"
          >
            {{ carrier.role }} ({{ carrier.holders }})
          </UButton>
        </div>
        <span
          v-else
          class="text-sm text-muted"
        >no role carries it</span>
      </template>
    </UTable>

    <UAlert
      v-if="!pending && !rows.length"
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      title="Nothing declared yet"
      description="Permissions arrive when an app's manifest is synced. Turn one on under Apps."
    />
  </UContainer>
</template>

<script lang="ts" setup>
definePageMeta({
  middleware: 'admin',
  title: 'Admin — permissions',
})

const { data, pending } = await useFetch('/api/permissions')
const rows = computed(() => data.value?.permissions ?? [])

const columns = [
  { id: 'key', header: 'Permission' },
  { accessorKey: 'description', header: 'Means', meta: { class: { td: 'max-w-96 text-muted' } } },
  { id: 'roles', header: 'Carried by' },
]
</script>
