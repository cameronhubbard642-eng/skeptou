/**
 * quartz.config.ts — phronesis
 *
 * Quartz 4 configuration for phronesis.skeptou.com.
 * Design token integration: skeptou.css is served from static/ and
 * linked via the Head component override below.
 *
 * Font: Borges (Access-gated license confirmed). Fallback: Cormorant.
 * body.private class on <body> activates Borges in skeptou.css.
 */

import { QuartzConfig } from '@jackyzha0/quartz/cfg'
import * as Plugin from '@jackyzha0/quartz/plugins'

const config: QuartzConfig = {
  configuration: {
    pageTitle: 'Phronesis',
    enableSPA: true,
    enablePopovers: false,
    analytics: null,        /* No analytics on private subdomain */
    locale: 'en-US',
    baseUrl: 'phronesis.skeptou.com',
    ignorePatterns: [
      'private',
      'templates',
      '.obsidian',
      'calendar.ics',
      'commitments.md'      /* Excluded build-time inputs — never rendered */
    ],
    defaultDateType: 'created',
    theme: {
      fontOrigin: 'local',  /* Borges served from static/fonts/borges/ */
      cdnCaching: false,
      typography: {
        header: 'Borges-Gris',
        body:   'Borges-Gris',
        code:   'monospace'
      },
      colors: {
        lightMode: {
          light:        '#fcf5e5',  /* Parchment — background */
          lightgray:    '#e8ddd0',  /* Parchment-dark */
          gray:         '#51414f',  /* Quartz */
          darkgray:     '#915f6d',  /* Mauve */
          dark:         '#301934',  /* Purple — body text */
          secondary:    '#722f37',  /* Wine — emphasis */
          tertiary:     '#4682b4',  /* Steel */
          highlight:    'rgba(70, 130, 180, 0.08)',
          textHighlight: 'rgba(145, 95, 109, 0.15)'
        },
        /* Phronesis is Access-gated; no dark mode toggle exposed.
         * Dark mode colors mirror light (Parchment UI is the canonical look). */
        darkMode: {
          light:        '#fcf5e5',
          lightgray:    '#e8ddd0',
          gray:         '#51414f',
          darkgray:     '#915f6d',
          dark:         '#301934',
          secondary:    '#722f37',
          tertiary:     '#4682b4',
          highlight:    'rgba(70, 130, 180, 0.08)',
          textHighlight: 'rgba(145, 95, 109, 0.15)'
        }
      }
    }
  },

  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({ priority: ['frontmatter', 'git', 'filesystem'] }),
      Plugin.SyntaxHighlighting(),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents({ collapseByDefault: true }),
      Plugin.CrawlLinks({ markdownLinkResolution: 'shortest' }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: 'katex' })
    ],

    filters: [
      Plugin.RemoveDrafts()    /* Removes commitments.md and calendar.ics from graph */
    ],

    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({ enableSiteMap: false, enableRSS: false }),
      Plugin.Assets(),
      Plugin.Static()
    ]
  }
}

export default config
