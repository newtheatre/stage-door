<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <UAlert
      v-if="freshToken"
      color="warning"
      icon="i-lucide-key-round"
      title="Copy this token now — it will not be shown again"
    >
      <template #description>
        <code class="break-all select-all">{{ freshToken }}</code>
        <p class="mt-2 text-sm">
          Put it straight into the password manager and the app's
          <code>AUTH_SERVICE_TOKEN</code> worker secret (docs/operations.md).
        </p>
      </template>
    </UAlert>

    <div class="flex gap-2 items-end">
      <UInput
        v-model="newName"
        placeholder="App name, e.g. proscenium"
        class="w-56"
      />
      <UButton
        icon="i-lucide-plus"
        :loading="creating"
        @click="create"
      >
        Issue token
      </UButton>
    </div>

    <UTable
      :data="rows"
      :columns="columns"
      :loading="pending"
    >
      <template #actions-cell="{ row }">
        <UButton
          variant="ghost"
          color="error"
          size="sm"
          icon="i-lucide-trash-2"
          @click="revoke(row.original.id, row.original.name)"
        >
          Revoke
        </UButton>
      </template>
    </UTable>
  </UContainer>
</template>

<script lang="ts" setup>
definePageMeta({
  middleware: 'admin',
  title: 'Admin — service tokens',
})

const toast = useToast()

const { data, pending, refresh } = await useFetch('/api/service-tokens')

const rows = computed(() => (data.value?.tokens ?? []).map(t => ({
  id: t.id,
  name: t.name,
  created: formatDate(t.createdAt),
  lastUsed: t.lastUsedAt ? formatDateTime(t.lastUsedAt) : 'never',
})))

const columns = [
  { accessorKey: 'name', header: 'App' },
  { accessorKey: 'created', header: 'Issued' },
  { accessorKey: 'lastUsed', header: 'Last used' },
  { id: 'actions', header: '' },
]

const newName = ref('')
const creating = ref(false)
const freshToken = ref('')

async function create() {
  creating.value = true
  try {
    const result = await $fetch('/api/service-tokens', {
      method: 'POST',
      body: { name: newName.value.trim() },
    })
    freshToken.value = result.token
    newName.value = ''
    await refresh()
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not issue token'), color: 'error' })
  }
  finally {
    creating.value = false
  }
}

async function revoke(id: string, name: string) {
  try {
    await $fetch(`/api/service-tokens/${id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: `Token for ${name} revoked`, color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not revoke'), color: 'error' })
  }
}
</script>
