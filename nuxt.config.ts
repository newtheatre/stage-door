// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({

  modules: [
    '@nuxt/ui',
    '@nuxt/eslint',
    '@nuxthub/core',
    'nuxt-auth-utils',
  ],

  $production: {
    runtimeConfig: {
      // The session cookie is scoped to the parent domain so every
      // *.newtheatre.org.uk app can read it (docs/session-contract.md).
      // Production only — localhost has no subdomains (docs/development.md).
      // name/password/maxAge repeat the base values: env overrides must be
      // complete SessionConfig objects, they don't deep-merge in types.
      session: {
        name: 'nnt-session',
        password: '',
        maxAge: 60 * 60 * 24 * 30,
        cookie: { domain: '.newtheatre.org.uk', sameSite: 'lax', secure: true },
      },
      public: {
        baseURL: 'https://auth.newtheatre.org.uk',
      },
    },

    hub: {
      db: {
        dialect: 'sqlite',
        driver: 'd1', // FIXME: https://github.com/nuxt-hub/core/pull/775 (same as Proscenium)
        connection: { databaseId: '6b5be553-53e1-4eb2-b027-6fc11f9fe8f4' },
      },
      kv: false,
      blob: false,
    },
  },

  devtools: { enabled: true },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    // NUXT_SESSION_PASSWORD is consumed implicitly by nuxt-auth-utils.
    session: {
      name: 'nnt-session',
      password: '',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    },
    resendApiKey: '',
    resendFromEmail: '',
    public: {
      baseURL: 'http://localhost:3000',
    },
  },

  compatibilityDate: '2025-07-15',

  nitro: {
    preset: 'cloudflare_module',
    experimental: {
      tasks: true,
    },
    scheduledTasks: {
      // Nightly rate-limit counter sweep (ADR-0009). Runs off the wrangler
      // cron trigger below in production.
      '0 3 * * *': ['rate-limits:sweep'],
      // Daily retention sweep (docs/gdpr-retention.md) — dry-run until the
      // Archivist arms it in retentionConfig — and role-expiry warnings
      // (ADR-0011).
      '0 4 * * *': ['retention:sweep', 'roles:expiry-warn'],
    },
    rollupConfig: {
      plugins: [
        // Resend imports @react-email/render, which doesn't bundle on Workers.
        // Same stub workaround as Proscenium.
        {
          name: 'stub-react-email',
          resolveId(id: string) {
            if (id === '@react-email/render') return id
          },
          load(id: string) {
            if (id === '@react-email/render') return 'export {}'
          },
        },
        // @simplewebauthn/server top-level re-exports cross-fetch, which has
        // no exports map — rollup can resolve it to node-fetch@2 and drag in
        // node:http. It's only used by MetadataService/isCertRevoked, neither
        // of which we touch, so point it at the platform fetch. Unlike the
        // stub above this needs a real named export, since deps.js re-exports
        // `fetch` by name.
        {
          name: 'stub-cross-fetch',
          resolveId(id: string) {
            if (id === 'cross-fetch') return id
          },
          load(id: string) {
            if (id === 'cross-fetch') {
              return 'export const fetch = globalThis.fetch\nexport default globalThis.fetch'
            }
          },
        },
      ],
    },
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: 'stage-door',
        routes: [
          {
            pattern: 'auth.newtheatre.org.uk',
            custom_domain: true,
          },
        ],
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'auth',
            database_id: '6b5be553-53e1-4eb2-b027-6fc11f9fe8f4',
          },
        ],
        // Estate-wide secrets live in the account Secrets Store so a rotation
        // is one write rather than four worker secrets updated in lockstep
        // (docs/operations.md#secrets). server/plugins/secrets-store.ts turns
        // the binding into runtimeConfig.session.password — read its header
        // before adding another entry here, the binding name matters.
        //
        // Cast: `secrets_store_secrets` is valid wrangler config but missing
        // from the wrangler types Nitro 2.13 bundles. Drop it once Nitro
        // catches up.
        ...({
          secrets_store_secrets: [
            {
              binding: 'SESSION_PASSWORD',
              store_id: 'fdfe08b6b01f498fbddbc08c2891cadb',
              secret_name: 'NUXT_SESSION_PASSWORD',
            },
          ],
        } as object),
        observability: {
          logs: {
            enabled: true,
          },
        },
        triggers: {
          crons: ['0 3 * * *', '0 4 * * *'],
        },
      },
    },
  },

  hub: {
    db: 'sqlite',
    kv: false,
    cache: false,
    blob: false,
  },

  // Passkeys (ADR-0012). Off by default in nuxt-auth-utils; enabling it
  // requires the @simplewebauthn peers (the module process.exit(1)s at build
  // without them). Note the casing: module option `webAuthn`, runtimeConfig
  // key `webauthn`.
  auth: {
    webAuthn: true,
  },

  eslint: {
    config: {
      stylistic: true,
    },
  },
})
