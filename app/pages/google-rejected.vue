<template>
  <UContainer class="flex flex-col items-center justify-center gap-4 p-4 flex-1">
    <UPageCard
      class="w-full max-w-md text-center"
      title="That Google account isn't an NNT account"
      icon="i-lucide-shield-x"
    >
      <template #description>
        Google sign-in is only for <code>@newtheatre.org.uk</code> Workspace
        accounts (members, committee and alumni role accounts). If that's not
        you, no problem: use an email and password instead.
      </template>

      <div class="flex flex-col gap-2">
        <UButton
          to="/register"
          block
        >
          Create an account with email
        </UButton>
        <UButton
          to="/login"
          variant="outline"
          block
        >
          Back to log in
        </UButton>
      </div>

      <p class="text-xs text-muted mt-4">
        Think you should have access with this Google account? Contact the IT
        Manager: it may just need linking.
      </p>
    </UPageCard>
  </UContainer>
</template>

<script lang="ts" setup>
definePageMeta({
  title: 'Google sign-in unavailable',
})
</script>
