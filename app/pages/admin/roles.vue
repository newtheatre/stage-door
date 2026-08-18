<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <div class="flex flex-wrap items-center gap-2">
      <p class="text-sm text-muted flex-1 min-w-64">
        Definitions drive the role picker on user pages, with the default
        expiry pre-filled. A role must be defined before it can be granted
        (ADR-0014); deleting a definition never touches existing grants.
        Most come from their app's manifest (ADR-0018). A withdrawn one is a
        role its app has stopped reading: it cannot be granted again, and its
        existing holders are untouched until someone revokes them.
      </p>
      <UButton
        icon="i-lucide-shield-plus"
        @click="startAdd"
      >
        Add definition
      </UButton>
    </div>

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

      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton
            variant="ghost"
            size="xs"
            icon="i-lucide-pencil"
            :aria-label="`Edit ${row.original.role}`"
            @click="startEdit(row.original.definition)"
          />
          <UButton
            variant="ghost"
            color="error"
            size="xs"
            icon="i-lucide-trash-2"
            :aria-label="`Delete ${row.original.role}`"
            @click="askDelete(row.original.definition)"
          />
        </div>
      </template>
    </UTable>

    <p
      v-if="!pending && !tableRows.length"
      class="text-sm text-muted"
    >
      No definitions yet — add the roles your apps check.
    </p>

    <!-- ── Add / edit ──────────────────────────────────────────────────── -->
    <UModal
      v-model:open="formOpen"
      :title="editingId ? 'Edit definition' : 'Add a definition'"
      :description="editingId ? undefined : 'The name must match what the app checks — apps never read this table, only the session strings.'"
    >
      <template #body>
        <UForm
          :state="form"
          class="flex flex-col gap-4"
          @submit="save"
        >
          <div class="flex gap-2">
            <UFormField
              label="Namespace"
              name="namespace"
              class="flex-1"
              :help="editingId ? undefined : 'The app, e.g. proscenium'"
            >
              <UInput
                v-model="form.namespace"
                placeholder="proscenium"
                :disabled="!!editingId"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Role"
              name="role"
              class="flex-1"
              :help="editingId ? undefined : 'UPPER_SNAKE, e.g. BOX_OFFICE'"
            >
              <UInput
                v-model="form.role"
                placeholder="BOX_OFFICE"
                :disabled="!!editingId"
                class="w-full"
              />
            </UFormField>
          </div>
          <UFormField
            label="Description"
            name="description"
            help="Shown in the role picker — say what it lets someone do"
          >
            <UInput
              v-model="form.description"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Default expiry"
            name="expiryKind"
            help="Pre-filled when granting; always changeable per grant"
          >
            <USelect
              v-model="form.expiryKind"
              :items="expiryOptions"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="form.expiryKind === 'days'"
            label="Days"
            name="expiryDays"
          >
            <UInput
              v-model.number="form.expiryDays"
              type="number"
              min="1"
              max="3650"
              class="w-32"
            />
          </UFormField>
          <div class="flex gap-2">
            <UButton
              type="submit"
              :loading="saving"
            >
              {{ editingId ? 'Save changes' : 'Add definition' }}
            </UButton>
            <UButton
              variant="ghost"
              color="neutral"
              @click="closeForm"
            >
              Cancel
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- ── Delete confirmation ─────────────────────────────────────────── -->
    <UModal
      v-model:open="deleteOpen"
      title="Delete this definition"
      :description="pendingDelete
        ? `${pendingDelete.namespace}:${pendingDelete.role} disappears from the role picker. ${holdersOf(pendingDelete)} — existing grants are never touched.`
        : ''"
    >
      <template #body>
        <div class="flex gap-2">
          <UButton
            color="error"
            :loading="deleting"
            @click="confirmDelete"
          >
            Delete definition
          </UButton>
          <UButton
            variant="ghost"
            color="neutral"
            @click="closeDelete"
          >
            Cancel
          </UButton>
        </div>
      </template>
    </UModal>
  </UContainer>
</template>

<script lang="ts" setup>
definePageMeta({
  middleware: 'admin',
  title: 'Admin — role definitions',
})

const toast = useToast()

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
}

const { data, pending, refresh } = await useFetch<{ definitions: Definition[] }>('/api/role-definitions')

const columns = [
  { accessorKey: 'role', header: 'Role' },
  { accessorKey: 'description', header: 'Description', meta: { class: { td: 'max-w-72 truncate text-muted' } } },
  { accessorKey: 'expiry', header: 'Default expiry' },
  { accessorKey: 'holders', header: 'Holders' },
  { accessorKey: 'actions', header: '' },
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

const expiryOptions = [
  { label: 'None (permanent)', value: 'none' },
  { label: 'End of committee year (31 July)', value: 'committee-year' },
  { label: 'Fixed number of days', value: 'days' },
]

// ── Add / edit ──────────────────────────────────────────────────────────────

const formOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const form = reactive({
  namespace: '',
  role: '',
  description: '',
  expiryKind: 'none' as 'none' | 'committee-year' | 'days',
  expiryDays: 30,
})

function closeForm() {
  formOpen.value = false
}

function startAdd() {
  editingId.value = null
  Object.assign(form, { namespace: '', role: '', description: '', expiryKind: 'none', expiryDays: 30 })
  formOpen.value = true
}

function startEdit(definition: Definition) {
  editingId.value = definition.id
  form.namespace = definition.namespace
  form.role = definition.role
  form.description = definition.description
  form.expiryKind = definition.defaultExpiryKind
  form.expiryDays = definition.defaultExpiryDays ?? 30
  formOpen.value = true
}

async function save() {
  saving.value = true
  const defaultExpiry = form.expiryKind === 'days'
    ? { kind: 'days', days: form.expiryDays }
    : { kind: form.expiryKind }
  try {
    if (editingId.value) {
      await $fetch(`/api/role-definitions/${editingId.value}`, {
        method: 'PUT',
        body: { description: form.description, defaultExpiry },
      })
    }
    else {
      await $fetch('/api/role-definitions', {
        method: 'POST',
        body: { namespace: form.namespace, role: form.role, description: form.description, defaultExpiry },
      })
    }
    formOpen.value = false
    await refresh()
    toast.add({ title: 'Definition saved', color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not save definition'), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

const deleteOpen = ref(false)
const deleting = ref(false)
const pendingDelete = ref<Definition | null>(null)

function holdersOf(definition: Definition): string {
  return definition.holders === 0
    ? 'Nobody currently holds it'
    : `${definition.holders} ${definition.holders === 1 ? 'person holds' : 'people hold'} it right now`
}

function closeDelete() {
  deleteOpen.value = false
}

function askDelete(definition: Definition) {
  pendingDelete.value = definition
  deleteOpen.value = true
}

async function confirmDelete() {
  const definition = pendingDelete.value
  if (!definition) return
  deleting.value = true
  try {
    await $fetch(`/api/role-definitions/${definition.id}`, { method: 'DELETE' })
    deleteOpen.value = false
    await refresh()
    toast.add({ title: `${definition.namespace}:${definition.role} removed (grants untouched)`, color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not delete'), color: 'error' })
  }
  finally {
    deleting.value = false
  }
}
</script>
