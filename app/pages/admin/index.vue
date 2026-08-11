<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <div class="flex flex-wrap gap-2 items-end">
      <UInput
        v-model="q"
        placeholder="Search email or name…"
        icon="i-lucide-search"
        class="w-64"
      />
      <USelect
        v-model="filter"
        :items="filterOptions"
        class="w-44"
      />
      <div class="flex-1" />
      <UButton
        icon="i-lucide-user-round-plus"
        @click="openCreate"
      >
        Create user
      </UButton>
    </div>

    <UTable
      :data="rows"
      :columns="columns"
      :loading="pending"
      @select="(_e: Event, row: TableRow<Row>) => onSelect(row)"
    />

    <div class="flex items-center justify-between">
      <p class="text-sm text-muted">
        {{ data?.total ?? 0 }} users
      </p>
      <UPagination
        v-model:page="page"
        :total="data?.total ?? 0"
        :items-per-page="data?.pageSize ?? 20"
      />
    </div>

    <UModal
      v-model:open="createOpen"
      title="Create user"
      description="They'll receive a set-password email — no generated passwords."
    >
      <template #body>
        <UForm
          :state="createForm"
          class="flex flex-col gap-4"
          @submit="createUser"
        >
          <UFormField
            label="Name"
            name="name"
            required
          >
            <UInput
              v-model="createForm.name"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Email"
            name="email"
            required
          >
            <UInput
              v-model="createForm.email"
              type="email"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Roles (comma-separated, e.g. rooms:ADMIN)"
            name="roles"
          >
            <UInput
              v-model="createForm.roles"
              placeholder="optional"
              class="w-full"
            />
          </UFormField>
          <UButton
            type="submit"
            :loading="creating"
            class="self-end"
          >
            Create and send set-password email
          </UButton>
        </UForm>
      </template>
    </UModal>
  </UContainer>
</template>

<script lang="ts" setup>
import type { TableRow } from '@nuxt/ui'

definePageMeta({
  middleware: 'admin',
  title: 'Admin — users',
})

const toast = useToast()

const q = ref('')
const filter = ref('all')
const page = ref(1)

const filterOptions = [
  { label: 'Everyone', value: 'all' },
  { label: 'Full accounts', value: 'full' },
  { label: 'Guests (shadow)', value: 'guest' },
  { label: 'Disabled', value: 'disabled' },
]

const query = computed(() => ({
  ...(q.value ? { q: q.value } : {}),
  ...(filter.value === 'guest' ? { guest: 'true' } : {}),
  ...(filter.value === 'full' ? { guest: 'false' } : {}),
  ...(filter.value === 'disabled' ? { disabled: 'true' } : {}),
  page: page.value,
}))

watch([q, filter], () => {
  page.value = 1
})

const { data, pending, refresh } = await useFetch('/api/users', { query })

interface Row {
  id: string
  email: string
  name: string
  status: string
  roles: string
}

interface ApiUser {
  id: string
  email: string
  name: string
  verified: boolean
  guest: boolean
  disabled: boolean
  roles: string[]
}

const rows = computed<Row[]>(() => ((data.value?.users ?? []) as ApiUser[]).map(u => ({
  id: u.id,
  email: u.email,
  name: u.name,
  status: u.disabled ? 'Disabled' : u.guest ? 'Guest' : u.verified ? 'Verified' : 'Unverified',
  roles: u.roles.join(', ') || '—',
})))

const columns = [
  { accessorKey: 'email', header: 'Email' },
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'roles', header: 'Roles' },
]

function onSelect(row: TableRow<Row>) {
  navigateTo(`/admin/users/${row.original.id}`)
}

const createOpen = ref(false)
const creating = ref(false)
const createForm = reactive({ name: '', email: '', roles: '' })

function openCreate() {
  createOpen.value = true
}

async function createUser() {
  creating.value = true
  try {
    const roles = createForm.roles.split(',').map(r => r.trim()).filter(Boolean)
    const result = await $fetch('/api/users', {
      method: 'POST',
      body: { name: createForm.name, email: createForm.email, roles },
    })
    createOpen.value = false
    Object.assign(createForm, { name: '', email: '', roles: '' })
    await refresh()
    toast.add({ title: 'User created — set-password email sent', color: 'success' })
    await navigateTo(`/admin/users/${result.user.id}`)
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not create user'), color: 'error' })
  }
  finally {
    creating.value = false
  }
}
</script>
