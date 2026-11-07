import { describe, expect, it } from 'vitest'
import { ASSEMBLY_FILES } from '../src/domain.ts'
import { ONBOARDING_SECTION_NAME, renderOnboarding } from '../src/onboarding.ts'

describe('onboarding guidance', () => {
  it('uses a stable section name', () => {
    expect(ONBOARDING_SECTION_NAME).toBe('laputa:onboarding')
  })

  it('lists the pending files', () => {
    const text = renderOnboarding(['IDENTITY.MD', 'MISSION.MD'])
    expect(text).toContain('IDENTITY.MD, MISSION.MD')
  })

  it('asks the two core questions one at a time', () => {
    const text = renderOnboarding([...ASSEMBLY_FILES])
    expect(text).toContain('Who am I?')
    expect(text).toContain('IDENTITY')
    expect(text).toContain('What is my mission?')
    expect(text).toContain('MISSION')
    expect(text).toContain('one question at a time')
  })

  it('offers advanced setup without asking the user for dream or dark', () => {
    const text = renderOnboarding([...ASSEMBLY_FILES])
    expect(text).toContain('RELATIONSHIP')
    expect(text).toContain('REDLINE')
    expect(text).toContain('DREAM')
    expect(text).toContain('DARK')
    expect(text).toContain('never questions for the user')
    expect(text).toContain('same laputa_init call')
  })

  it('requires explicit answers and create-only writes', () => {
    const text = renderOnboarding([...ASSEMBLY_FILES])
    expect(text).toContain('only after the user has answered explicitly')
    expect(text).toContain('never invent')
    expect(text).toContain('never overwrites')
    expect(text).toContain('laputa_init')
  })

  it('stops repeating setup when the user declines', () => {
    const text = renderOnboarding([...ASSEMBLY_FILES])
    expect(text).toContain('mention the setup once')
    expect(text).toContain('do not repeat')
  })

  it('falls back to manual editing when the tool is unavailable', () => {
    expect(renderOnboarding([])).toContain('edit the persona files directly')
  })
})
