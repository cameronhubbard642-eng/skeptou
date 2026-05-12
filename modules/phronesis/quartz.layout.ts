/**
 * quartz.layout.ts — phronesis
 *
 * Quartz 4 layout configuration.
 * Injects skeptou.css and design-tokens.css via Head component.
 * Activates body.private for Borges font stack.
 * §Roman section numbering via CSS counters in skeptou.css.
 */

import { PageLayout, SharedLayout } from '@jackyzha0/quartz/cfg'
import * as Component from '@jackyzha0/quartz/components'

/* ── Head injection: design tokens + skeptou CSS + PWA manifest ── */
const skHead = Component.Head()

/* Custom Head that adds body.private and skeptou stylesheets */
const SkeptoHead = () => ({
  ...skHead,
  beforeDOMLoaded: `
    document.documentElement.setAttribute('lang', 'en');
    document.body.classList.add('private');
  `
})

/* ── Shared layout (applies to all pages) ── */
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  footer: Component.Footer({
    links: {
      'Dashboard':     '/',
      'Manifest':      '/manifest',
      'Opportunities': '/opportunities',
      'Inventory':     '/inventory'
    }
  })
}

/* ── Default page layout ── */
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.Breadcrumbs(),
    Component.ArticleTitle(),
    Component.ContentMeta()
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Search(),
    Component.Darkmode(),           /* Hidden via CSS on private subdomains */
    Component.DesktopOnly(Component.Explorer({
      title: 'Navigation',
      folderClickBehavior: 'link',
      folderDefaultState: 'open',
      sortFn: (a, b) => a.name.localeCompare(b.name)
    }))
  ],
  right: [
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks()
  ]
}

/* ── Listing pages (folder index, tag pages) ── */
export const defaultListPageLayout: PageLayout = {
  beforeBody: [
    Component.Breadcrumbs(),
    Component.ArticleTitle(),
    Component.ContentMeta()
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Search(),
    Component.DesktopOnly(Component.Explorer())
  ],
  right: []
}
