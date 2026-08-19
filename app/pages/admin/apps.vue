<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <div class="flex flex-wrap items-center gap-2">
      <p class="text-sm text-muted flex-1 min-w-64">
        The estate's apps. A row is what makes an app real: GDPR hooks reach it
        and, from here on, its roles come from its own manifest. Adding one
        needs no deploy of this service (ADR-0017).
      </p>
      <UButton
        icon="i-lucide-plus"
        @click="startAdd"
      >
        Register app
      </UButton>
    </div>

    <UAlert
      v-if="missingToken.length"
      color="warning"
      icon="i-lucide-key-round"
      title="Registered, but not callable"
    >
      <template #description>
        {{ missingToken.join(', ') }}
        {{ missingToken.length === 1 ? 'has' : 'have' }} no service token, so
        hooks cannot authenticate. Issue one under Service tokens using the
        same app name.
      </template>
    </UAlert>

    <UAlert
      v-if="failingSync.length"
      color="error"
      icon="i-lucide-triangle-alert"
      title="Manifest sync is failing"
    >
      <template #description>
        {{ failingSync.join(', ') }}. The last good manifest is still in force,
        so no role has been withdrawn. Fix the app or its base URL, then sync.
      </template>
    </UAlert>

    <UTable
      :data="rows"
      :columns="columns"
      :loading="pending"
    >
      <template #manifest-cell="{ row }">
        <div class="flex items-center gap-2">
          <UBadge
            :color="manifestColour(row.original)"
            variant="subtle"
          >
            {{ manifestLabel(row.original) }}
          </UBadge>
          <UButton
            v-if="row.original.manifestEnabled"
            variant="ghost"
            size="xs"
            icon="i-lucide-refresh-cw"
            :loading="syncing === row.original.id"
            aria-label="Sync now"
            @click="syncNow(row.original)"
          />
        </div>
      </template>
      <template #hooks-cell="{ row }">
        <UBadge
          :color="row.original.hooksEnabled ? 'success' : 'neutral'"
          variant="subtle"
        >
          {{ row.original.hooksEnabled ? 'On' : 'Off' }}
        </UBadge>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex gap-1 justify-end">
          <UButton
            variant="ghost"
            size="sm"
            icon="i-lucide-pencil"
            aria-label="Edit"
            @click="startEdit(row.original)"
          />
          <UButton
            variant="ghost"
            color="error"
            size="sm"
            icon="i-lucide-trash-2"
            aria-label="Deregister"
            @click="deregister(row.original)"
          />
        </div>
      </template>
    </UTable>

    <UModal
      v-model:open="formOpen"
      :title="editing ? `Edit ${form.name}` : 'Register an app'"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <UFormField
            label="Name"
            description="Lowercase, matches the service token, e.g. rehearsal"
          >
            <UInput
              v-model="form.name"
              :disabled="editing !== null"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Role namespace"
            description="Often the same as the name, but rehearsal serves 'training'"
          >
            <UInput
              v-model="form.namespace"
              :disabled="editing !== null"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Display name">
            <UInput
              v-model="form.displayName"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Base URL"
            description="No trailing slash. https, or http://localhost for development"
          >
            <UInput
              v-model="form.baseUrl"
              class="w-full"
            />
          </UFormField>
          <UCheckbox
            v-model="form.hooksEnabled"
            label="Send GDPR hooks"
            description="Export, anonymise, last-activity and merge"
          />
          <UCheckbox
            v-model="form.manifestEnabled"
            label="Read its role manifest"
            description="Roles and permissions come from the app. Sync once by hand first and read the result."
          />
        </div>
      </template>
      <template #footer>
        <div class="flex gap-2 justify-end w-full">
          <UButton
            variant="ghost"
            @click="() => { formOpen = false }"
          >
            Cancel
          </UButton>
          <UButton
            :loading="saving"
            @click="save"
          >
            {{ editing ? 'Save' : 'Register' }}
          </UButton>
        </div>
      </template>
    </UModal>
  </UContainer>
</template>

<script lang="ts" setup>
definePageMeta({
  middleware: 'admin',
  title: 'Admin: apps',
})

const toast = useToast()
const { data, pending, refresh } = await useFetch('/api/apps')

const rows = computed(() => data.value?.apps ?? [])
const missingToken = computed(() => rows.value.filter(a => !a.hasToken).map(a => a.name))
const failingSync = computed(() => rows.value.filter(a => a.manifest?.lastError).map(a => a.name))

const columns = [
  { accessorKey: 'displayName', header: 'App' },
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'namespace', header: 'Namespace' },
  { accessorKey: 'baseUrl', header: 'Base URL' },
  { id: 'hooks', header: 'Hooks' },
  { id: 'manifest', header: 'Manifest' },
  { id: 'actions', header: '' },
]

type AppRow = (typeof rows.value)[number]

function manifestLabel(app: AppRow) {
  if (!app.manifestEnabled) return 'Off'
  if (app.manifest?.lastError) return 'Failing'
  if (!app.manifest?.appliedAt) return 'Never synced'
  return `v${app.manifest.version}`
}

function manifestColour(app: AppRow) {
  if (!app.manifestEnabled) return 'neutral'
  if (app.manifest?.lastError) return 'error'
  if (!app.manifest?.appliedAt) return 'warning'
  return 'success'
}

const syncing = ref<string | null>(null)

async function syncNow(app: AppRow) {
  syncing.value = app.id
  try {
    const result = await $fetch(`/api/apps/${app.id}/sync`, { method: 'POST' })
    await refresh()
    toast.add(result.ok
      ? { title: result.unchanged ? `${app.displayName} is up to date` : `${app.displayName} synced`, color: 'success' }
      : { title: `${app.displayName}: ${result.error}`, color: 'error' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not sync'), color: 'error' })
  }
  finally {
    syncing.value = null
  }
}

const formOpen = ref(false)
const saving = ref(false)
const editing = ref<string | null>(null)
const form = reactive({ name: '', namespace: '', displayName: '', baseUrl: '', hooksEnabled: false, manifestEnabled: false })

function startAdd() {
  editing.value = null
  Object.assign(form, { name: '', namespace: '', displayName: '', baseUrl: '', hooksEnabled: false, manifestEnabled: false })
  formOpen.value = true
}

function startEdit(app: (typeof rows.value)[number]) {
  editing.value = app.id
  Object.assign(form, {
    name: app.name,
    namespace: app.namespace,
    displayName: app.displayName,
    baseUrl: app.baseUrl,
    hooksEnabled: app.hooksEnabled,
    manifestEnabled: app.manifestEnabled,
  })
  formOpen.value = true
}

async function save() {
  saving.value = true
  try {
    if (editing.value) {
      await $fetch(`/api/apps/${editing.value}`, {
        method: 'PUT',
        body: {
          displayName: form.displayName,
          baseUrl: form.baseUrl,
          hooksEnabled: form.hooksEnabled,
          manifestEnabled: form.manifestEnabled,
        },
      })
    }
    else {
      await $fetch('/api/apps', { method: 'POST', body: { ...form } })
    }
    formOpen.value = false
    await refresh()
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not save'), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

async function deregister(app: (typeof rows.value)[number]) {
  try {
    await $fetch(`/api/apps/${app.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: `${app.displayName} deregistered`, color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not deregister'), color: 'error' })
  }
}
</script>
