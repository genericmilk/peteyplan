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
        { key: 'peteyplan-favicon', id: 'peteyplan-favicon', rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
      // Apply saved theme/density before first paint so day mode doesn't flash dark.
      script: [
        {
          tagPosition: 'head',
          innerHTML: `try{var p=JSON.parse(localStorage.getItem('peteyplan-prefs')||'{}'),r=document.documentElement,t=p.theme==='light'||p.theme==='dark'?p.theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';r.dataset.theme=t;if(p.density==='compact')r.dataset.density='compact';if(p.surface==='solid')r.dataset.surface='solid'}catch(e){}`,
        },
      ],
    },
  },

  css: ['@fontsource-variable/geist', '@fontsource-variable/geist-mono', '~/assets/css/main.css'],
})
