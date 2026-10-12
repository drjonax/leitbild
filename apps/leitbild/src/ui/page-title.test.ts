import { describe, expect, test } from 'bun:test'
import { BRAND_TITLE, pageTitle, workspacePageTitle } from './page-title.ts'

describe('tab titles', () => {
  test('end in " · Leitbild.ai"', () => {
    expect(BRAND_TITLE).toBe('Leitbild.ai')
    expect(pageTitle('Grid study')).toBe('Grid study · Leitbild.ai')
    expect(pageTitle('  Halden: loss of offsite power ')).toBe('Halden: loss of offsite power · Leitbild.ai')
  })

  test('show the brand alone while nothing is known', () => {
    expect(pageTitle(null)).toBe('Leitbild.ai')
    expect(pageTitle(undefined)).toBe('Leitbild.ai')
    expect(pageTitle('   ')).toBe('Leitbild.ai')
  })

  test('name the open Run, else the open conversation, else the Workspace', () => {
    expect(workspacePageTitle({ workspace: 'Grid study', run: 'Nordland corridor', room: 'Assistance' })).toBe('Nordland corridor · Leitbild.ai')
    expect(workspacePageTitle({ workspace: 'Grid study', run: null, room: 'Getting started question' })).toBe('Getting started question · Leitbild.ai')
    expect(workspacePageTitle({ workspace: 'Untitled Workspace · b56b1d' })).toBe('Untitled Workspace · b56b1d · Leitbild.ai')
    expect(workspacePageTitle({ workspace: null })).toBe('Leitbild.ai')
  })

  test('never use the old " · Leitbild" suffix', () => {
    for (const title of [pageTitle('Run'), workspacePageTitle({ workspace: 'W' })]) expect(title).not.toMatch(/· Leitbild$/)
  })
})
