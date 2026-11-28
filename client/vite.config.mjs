// Plugins
import basicSsl from '@vitejs/plugin-basic-ssl'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import Pages from 'vite-plugin-pages'
import Vue from '@vitejs/plugin-vue'
// import VueRouter from 'unplugin-vue-router/vite'
import svgLoader from 'vite-svg-loader'

// Utilities
import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

// The client's build identity, baked into the bundle (issue #660). The docker build writes
// build-info.json here, in client/, before it runs vite build (the Dockerfile, the release bundle) ;
// a build without one - CI's client job, a developer's npm run build - is a 'dev' build. It
// used to be fetched at runtime from /build-info.json, but that file describes the server's
// disk, not the code running in the tab, and was cached for a year.
function clientBuildInfo() {
  try {
    const info = JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8'))
    if (info?.gitSha) return info
  } catch {
    // no build-info.json : a development build
  }
  return { gitSha: 'dev', dirty: false, buildTime: null }
}

// The development server serves index.html itself, not the app's server : it puts in the single
// sign-on providers that are on and the instance's name and label, as the app's server does
// (server/src/lib/ssoMeta.js, indexMeta.js), asked of the api behind the proxy, so the sign-in
// card and the header have them from the first frame here too. Each left out when the api
// cannot be reached. The server's helpers are loaded only here, when it serves : the image's
// client build stage has no server code (only formEngine), so an import broke npm run build.
function devSsoMeta(target) {
  return {
    name: 'af-dev-sso-meta',
    apply: 'serve',
    async transformIndexHtml(html) {
      const read = (path) => fetch(`${target}${path}`).then((res) => res.json()).catch(() => null)
      const [sso, config] = await Promise.all([read('/api/v2/auth/settings'), read('/api/v2/app/config')])
      const providers = sso ? [sso.azureAdEnabled && 'azuread', sso.oidcEnabled && 'oidc'].filter(Boolean) : null
      // the path built at run time : vite bundles this file and would resolve a fixed one
      const serverLib = (file) => new URL(`../server/src/lib/${file}`, import.meta.url).href
      const { injectSsoProviders } = await import(serverLib('ssoMeta.js'))
      const { injectAppIdentity } = await import(serverLib('indexMeta.js'))
      return injectAppIdentity(injectSsoProviders(html, providers), config)
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
// read .env / .env.local etc, so VITE_DEV_HOST can be set once per machine instead of
// exported in the shell every time
const env = loadEnv(mode, process.cwd(), '')
// a trusted certificate for the dev server when one is given (VITE_DEV_CERT and VITE_DEV_KEY,
// paths to PEM files, in client/.env.local) : browsers refuse a service worker - the desktop
// notifications' Approve and Reject buttons - on a self-signed one. None given : the plugin's
// own self-signed certificate, as before
const devCert = env.VITE_DEV_CERT && env.VITE_DEV_KEY
  ? { cert: readFileSync(env.VITE_DEV_CERT), key: readFileSync(env.VITE_DEV_KEY) }
  : null
return {
  // relative base, so a single build works under any subpath (issue #106)
  // the server rewrites the <base href="/"> tag in index.html at runtime (BASE_URL)
  base: './',
  plugins: [
    ...(devCert ? [] : [basicSsl()]),
    devSsoMeta(env.API_PROXY_TARGET || 'http://localhost:3001'),
    svgLoader(
      {defaultImport: 'url'}
    ),
    Pages(),
    Vue({
      template: { 
        compilerOptions: {
          isCustomElement: tag => ['badge'].includes(tag),
        }
      }
    }),
    Components(),
    AutoImport({
      imports: [
        'vue',
        'vue-router',
        { 'vue-i18n': ['useI18n'] },
      ],
      eslintrc: {
        enabled: true,
      },
      vueTemplate: true,
    }),
  ],
  define: { 'process.env': {}, __CLIENT_BUILD__: JSON.stringify(clientBuildInfo()) },
  resolve: {
    // yaml is deduped so the shared form engine (@engine, under server/) resolves it from
    // client/node_modules - server/node_modules does not exist when the image builds the client
    dedupe: ['vue', 'yaml'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '~@': fileURLToPath(new URL('./src', import.meta.url)),
      // the form engine shared with the server (MCP, launch validation) - browser-safe files only
      '@engine': fileURLToPath(new URL('../server/src/lib/formEngine', import.meta.url))
    },
    extensions: [
      '.js',
      '.json',
      '.jsx',
      '.mjs',
      '.ts',
      '.tsx',
      '.vue',
    ],
  },
  // Vite's own minifier. terser used to be configured here only to keep a few local names
  // unmangled for the direct eval in lib/Helpers.js; that code no longer uses a direct eval,
  // so nothing depends on local names surviving minification.
  build:{
    // FontAwesome's solid icon set is about 950 kB minified and cannot shrink: forms name their
    // icons in YAML, so every icon has to be available. It is the largest chunk by design;
    // anything bigger than this limit is a real regression worth the warning.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      // The plugin timings notice reports that JavaScript plugins (Vite's own CSS and Sass
      // handling) take most of the build. That is normal for a Vite build, not a problem to
      // fix, and it printed on almost every run.
      checks: { pluginTimings: false },
      output: {
        // Libraries in chunks of their own: they change far less often than the app, so a
        // browser keeps them cached across AnsibleForms upgrades, and the code editor is only
        // downloaded by the pages that use it.
        codeSplitting: {
          groups: [
            { name: 'vue', test: /node_modules[\\/](@vue|vue|vue-router|pinia)[\\/]/, priority: 60 },
            { name: 'fa-solid', test: /node_modules[\\/]@fortawesome[\\/]free-solid-svg-icons/, priority: 50 },
            { name: 'fa-brands', test: /node_modules[\\/]@fortawesome[\\/]free-brands-svg-icons/, priority: 50 },
            { name: 'fontawesome', test: /node_modules[\\/]@fortawesome/, priority: 40 },
            { name: 'ace', test: /node_modules[\\/]ace-builds/, priority: 30 },
            { name: 'vendor', test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
  },

  optimizeDeps: {
    include: ['vue3-ace-editor', 'ace-builds']
  },
  server: {
    // localhost-only by default (security fix #465) ; set VITE_DEV_HOST in client/.env.local
    // (e.g. to true or an IP) to expose it, for a remote/SSH dev setup, without changing
    // the default for everyone. env vars are always strings, so "true" needs parsing -
    // passed through as-is it makes Vite resolve a literal hostname called "true"
    host: env.VITE_DEV_HOST === 'true' ? true : (env.VITE_DEV_HOST || '127.0.0.1'),
    port: 8443,
    ...(devCert ? { https: devCert } : {}),
    // @engine lives outside client/ : let the dev server serve it
    fs: {
      allow: [fileURLToPath(new URL('..', import.meta.url))]
    },
    proxy: {
      '/api/': {
        target: env.API_PROXY_TARGET || 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      }
    }    
  },
  css: {
    preprocessorOptions: {
      scss: {
        silenceDeprecations: ['color-functions', 'global-builtin', 'import', 'if-function']
      },
    }
  },  
}
})
