<template>
  <UContainer class="flex flex-col gap-4 p-4 flex-1">
    <AdminNav />

    <div class="flex flex-wrap gap-2 items-end">
      <UInput
        v-model="action"
        placeholder="Filter by action, e.g. user.roles-changed"
        icon="i-lucide-filter"
        class="w-72"
      />
      <UInput
        v-model="target"
        placeholder="Filter by target id"
        class="w-56"
      />
      <div class="flex-1" />
      <UButton
        variant="outline"
        icon="i-lucide-plus"
        @click="openManual"
      >
        Record manual action
      </UButton>
    </div>

    <UTable
      :data="rows"
      :columns="columns"
      :loading="pending"
    />

    <div class="flex items-center justify-between">
      <p class="text-sm text-muted">
        {{ data?.total ?? 0 }} entries
      </p>
      <UPagination
        v-if="showPagination"
        v-model:page="page"
        :total="data?.total ?? 0"
        :items-per-page="data?.pageSize ?? 50"
      />
    </div>

    <UModal
      v-model:open="manualOpen"
      title="Record a manual action"
      description="For operations done outside the admin UI — secret rotations, wrangler surgery. Stored with a manual. prefix."
    >
      <template #body>
        <UForm
          :state="manualForm"
          class="flex flex-col gap-4"
          @submit="recordManual"
        >
          <UFormField
            label="Action"
            name="action"
            required
            help="e.g. session-secret-rotated"
          >
            <UInput
              v-model="manualForm.action"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Target"
            name="target"
            required
            help="What it applied to — 'estate', a user id, a worker name"
          >
            <UInput
              v-model="manualForm.target"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Note"
            name="detail"
          >
            <UTextarea
              v-model="manualForm.detail"
              class="w-full"
            />
          </UFormField>
          <UButton
            type="submit"
            :loading="recording"
            class="self-end"
          >
            Record
          </UButton>
        </UForm>
      </template>
    </UModal>
  </UContainer>
</template>

<script lang="ts" setup>
definePageMeta({
  middleware: 'admin',
  title: 'Admin — audit log',
})

const toast = useToast()

const action = ref('')
const target = ref('')
const page = ref(1)

const query = computed(() => ({
  ...(action.value ? { action: action.value } : {}),
  ...(target.value ? { target: target.value } : {}),
  page: page.value,
}))

watch([action, target], () => {
  page.value = 1
})

const { data, pending, refresh } = await useFetch('/api/audit', { query })

// A pager for a single page of results is noise.
const showPagination = computed(() => (data.value?.total ?? 0) > (data.value?.pageSize ?? 50))

interface ApiEntry {
  // Date server-side, ISO string once serialised — new Date() takes both.
  createdAt: string | Date
  action: string
  actorUserId: string | null
  target: string
  detail: string | null
}

const rows = computed(() => ((data.value?.entries ?? []) as unknown as ApiEntry[]).map(e => ({
  when: formatDateTime(e.createdAt),
  action: e.action,
  actor: e.actorUserId ?? 'system',
  target: e.target,
  detail: e.detail ?? '',
})))

const columns = [
  { accessorKey: 'when', header: 'When' },
  { accessorKey: 'action', header: 'Action' },
  { accessorKey: 'actor', header: 'Actor' },
  { accessorKey: 'target', header: 'Target' },
  { accessorKey: 'detail', header: 'Detail' },
]

const manualOpen = ref(false)
const recording = ref(false)
const manualForm = reactive({ action: '', target: '', detail: '' })

function openManual() {
  manualOpen.value = true
}

async function recordManual() {
  recording.value = true
  try {
    await $fetch('/api/audit', {
      method: 'POST',
      body: {
        action: manualForm.action,
        target: manualForm.target,
        ...(manualForm.detail ? { detail: manualForm.detail } : {}),
      },
    })
    manualOpen.value = false
    Object.assign(manualForm, { action: '', target: '', detail: '' })
    await refresh()
    toast.add({ title: 'Recorded', color: 'success' })
  }
  catch (error) {
    toast.add({ title: getErrorMessage(error, 'Could not record'), color: 'error' })
  }
  finally {
    recording.value = false
  }
}
</script>
