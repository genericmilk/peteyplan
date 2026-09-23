export default defineNuxtConfig({
  compatibilityDate: '2026-09-21',

  // App
  app: {
    head: {
      title: 'PeteyPlan',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },

  css: ['~/assets/css/main.css'],
})