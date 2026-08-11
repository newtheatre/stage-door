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
        // Set when the production D1 database is created — see docs/operations.md#deployments
        connection: { databaseId: 'REPLACE-WITH-AUTH-D1-DATABASE-ID' },
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
      ],
    },
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: 'auth',
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
            database_id: 'REPLACE-WITH-AUTH-D1-DATABASE-ID',
          },
        ],
        observability: {
          logs: {
            enabled: true,
          },
        },
        triggers: {
          crons: ['0 3 * * *'],
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

  eslint: {
    config: {
      stylistic: true,
    },
  },
})
