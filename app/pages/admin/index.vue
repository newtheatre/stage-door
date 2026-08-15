<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <!--
    A failed list fetch must never render as "0 users".
    -->
    <UAlert
      v-if="listError"
      color="error"
      icon="i-lucide-alert-circle"
      title="Could not load users"
      :description="getErrorMessage(listError, 'Something went wrong — try reloading.')"
    />

    <!-- Rollout hints for the Workspace/MFA rules (ADR-0012). Each one is a
         filter, so "who is left?" is one click rather than a search. -->
    <UAlert
      v-if="data?.needsAttention?.workspacePassword"
      color="warning"
      variant="subtle"
      icon="i-lucide-key-round"
      title="NNT addresses still holding a password"
      :description="`${data.needsAttention.workspacePassword} @newtheatre.org.uk ${data.needsAttention.workspacePassword === 1 ? 'account' : 'accounts'} can still be signed into with a password. These are usually handed-over role accounts: link the person's Google account, re-grant their roles to it, then clear the password.`"
      :actions="[{ label: 'Show them', variant: 'outline', onClick: () => { filter = 'workspace-password' } }]"
    />
    <UAlert
      v-if="data?.needsAttention?.adminNoMfa"
      color="warning"
      variant="subtle"
      icon="i-lucide-shield-alert"
      title="Admins without a second factor"
      :description="`${data.needsAttention.adminNoMfa} password ${data.needsAttention.adminNoMfa === 1 ? 'account holds' : 'accounts hold'} an admin role with no second factor set up. They can sign in, but admin tools stay closed until they enrol.`"
      :actions="[{ label: 'Show them', variant: 'outline', onClick: () => { filter = 'admin-no-mfa' } }]"
    />

    <!-- Deep-linked role filter (from a definition's holders count). -->
    <div
      v-if="roleFilter"
      class="flex items-center gap-2"
    >
      <span class="text-sm text-muted">Showing active holders of</span>
      <UBadge
        color="primary"
        variant="subtle"
      >
        {{ roleFilter }}
      </UBadge>
      <UButton
        variant="ghost"
        color="neutral"
        size="xs"
        icon="i-lucide-x"
        aria-label="Clear role filter"
        @click="clearRoleFilter"
      />
    </div>

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
    >
      <!--
      Badges wrap; a comma-joined string was clipped at narrow widths.
      -->
      <template #roles-cell="{ row }">
        <div
          v-if="row.original.roles.length"
          class="flex flex-wrap gap-1 max-w-52"
        >
          <UBadge
            v-for="role in row.original.roles"
            :key="role"
            color="primary"
            variant="subtle"
            size="sm"
            class="max-w-full truncate"
            :title="role"
          >
            {{ role }}
          </UBadge>
        </div>
        <span
          v-else
          class="text-muted"
        >—</span>
      </template>
    </UTable>

    <div class="flex items-center justify-between">
      <p class="text-sm text-muted">
        {{ data?.total ?? 0 }} users
        <template v-if="filter !== 'anonymised' && data?.hiddenAnonymised">
          · {{ data.hiddenAnonymised.toLocaleString() }} anonymised/placeholder accounts hidden
        </template>
      </p>
      <UPagination
        v-if="showPagination"
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
const route = useRoute()
const router = useRouter()

const q = ref('')
const filter = ref('all')
const page = ref(1)

const filterOptions = [
  { label: 'Everyone', value: 'all' },
  { label: 'Full accounts', value: 'full' },
  { label: 'Guests (shadow)', value: 'guest' },
  { label: 'Disabled', value: 'disabled' },
  { label: 'Anonymised / placeholders', value: 'anonymised' },
  { label: 'NNT address with password', value: 'workspace-password' },
  { label: 'Admins without 2-step', value: 'admin-no-mfa' },
]

// Role filter arrives as ?role= (linked from /admin/roles holder counts).
const roleFilter = computed(() => typeof route.query.role === 'string' ? route.query.role : '')

function clearRoleFilter() {
  router.replace({ query: { ...route.query, role: undefined } })
}

const query = computed(() => ({
  ...(q.value ? { q: q.value } : {}),
  ...(roleFilter.value ? { role: roleFilter.value } : {}),
  ...(filter.value === 'guest' ? { guest: 'true' } : {}),
  ...(filter.value === 'full' ? { guest: 'false' } : {}),
  ...(filter.value === 'disabled' ? { disabled: 'true' } : {}),
  ...(filter.value === 'anonymised' ? { anonymised: 'true' } : {}),
  ...(filter.value === 'workspace-password' ? { attention: 'workspace-password' } : {}),
  ...(filter.value === 'admin-no-mfa' ? { attention: 'admin-no-mfa' } : {}),
  page: page.value,
}))

watch([q, filter, roleFilter], () => {
  page.value = 1
})

const { data, pending, refresh, error: listError } = await useFetch('/api/users', { query })

// A pager for a single page of results is noise.
const showPagination = computed(() => (data.value?.total ?? 0) > (data.value?.pageSize ?? 20))

interface Row {
  id: string
  email: string
  name: string
  status: string
  roles: string[]
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
  roles: u.roles,
})))

// Capped so the table fits its container. Full values are in the title
// attribute and on the user page.
const columns = [
  { accessorKey: 'email', header: 'Email', meta: { class: { td: 'max-w-56 truncate' } } },
  { accessorKey: 'name', header: 'Name', meta: { class: { td: 'max-w-40 truncate' } } },
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
