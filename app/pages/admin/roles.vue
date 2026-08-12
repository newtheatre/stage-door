<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <UAlert
      icon="i-lucide-info"
      color="neutral"
      variant="subtle"
      title="Definitions drive the grant dropdown"
      description="Each entry appears in the role picker on user pages with its default expiry pre-filled. Definitions are UX metadata: deleting one never touches existing grants, and free-text grants still work without one."
    />

    <div class="grid md:grid-cols-2 gap-4">
      <UPageCard
        title="Defined roles"
        icon="i-lucide-shield-check"
      >
        <div class="flex flex-col gap-2">
          <div
            v-for="definition in data?.definitions ?? []"
            :key="definition.id"
            class="flex items-center gap-2 text-sm"
          >
            <UBadge
              color="primary"
              variant="subtle"
            >
              {{ definition.namespace }}:{{ definition.role }}
            </UBadge>
            <span class="text-muted flex-1 truncate">{{ definition.description }}</span>
            <UBadge
              color="neutral"
              variant="outline"
              size="sm"
            >
              {{ expiryLabel(definition) }}
            </UBadge>
            <UButton
              variant="ghost"
              size="xs"
              icon="i-lucide-pencil"
              @click="startEdit(definition)"
            />
            <UButton
              variant="ghost"
              color="error"
              size="xs"
              icon="i-lucide-trash-2"
              @click="removeDefinition(definition)"
            />
          </div>
          <p
            v-if="!(data?.definitions ?? []).length"
            class="text-sm text-muted"
          >
            No definitions yet — add the roles your apps check.
          </p>
        </div>
      </UPageCard>

      <UPageCard
        :title="editingId ? 'Edit definition' : 'Add a definition'"
        icon="i-lucide-shield-plus"
      >
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
            help="Shown in the grant dropdown — say what the role lets someone do"
          >
            <UInput
              v-model="form.description"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Default expiry"
            name="expiryKind"
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
              v-if="editingId"
              variant="ghost"
              color="neutral"
              @click="cancelEdit"
            >
              Cancel
            </UButton>
          </div>
        </UForm>
      </UPageCard>
    </div>
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
}

const { data, refresh } = await useFetch<{ definitions: Definition[] }>('/api/role-definitions')

const expiryOptions = [
  { label: 'None (permanent)', value: 'none' },
  { label: 'End of committee year (31 July)', value: 'committee-year' },
  { label: 'Fixed number of days', value: 'days' },
]

const editingId = ref<string | null>(null)
const saving = ref(false)
const form = reactive({
  namespace: '',
  role: '',
  description: '',
  expiryKind: 'none' as 'none' | 'committee-year' | 'days',
  expiryDays: 30,
})

function expiryLabel(definition: Definition): string {
  if (definition.defaultExpiryKind === 'committee-year') return 'end of year'
  if (definition.defaultExpiryKind === 'days') return `${definition.defaultExpiryDays}d`
  return 'permanent'
}

function startEdit(definition: Definition) {
  editingId.value = definition.id
  form.namespace = definition.namespace
  form.role = definition.role
  form.description = definition.description
  form.expiryKind = definition.defaultExpiryKind
  form.expiryDays = definition.defaultExpiryDays ?? 30
}

function cancelEdit() {
  editingId.value = null
  Object.assign(form, { namespace: '', role: '', description: '', expiryKind: 'none', expiryDays: 30 })
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
    cancelEdit()
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

async function removeDefinition(definition: Definition) {
  try {
    await $fetch(`/api/role-definitions/${definition.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: `${definition.namespace}:${definition.role} removed (grants untouched)`, color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not delete'), color: 'error' })
  }
}
</script>
