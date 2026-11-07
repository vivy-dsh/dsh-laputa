/**
 * Guided first-run setup text. It is injected only while the persona is
 * uninitialized and is phrased as model instructions; the persona section
 * itself stays empty so no half-written identity reaches the model.
 * @module dsh-laputa
 */

import type { PersonaFile } from './domain.ts'

/** Stable section name for the onboarding guidance. */
export const ONBOARDING_SECTION_NAME = 'laputa:onboarding'

/**
 * Render the onboarding instructions for the current pending files.
 * @param pending - missing, empty, or whitespace-only persona files.
 */
export function renderOnboarding(pending: readonly PersonaFile[]): string {
  const missing = pending.length === 0 ? 'none' : pending.join(', ')
  return [
    'The workspace persona is not initialized yet. Missing or empty: ' + missing + '.',
    'When the conversation starts, briefly tell the user in their language that no persona is saved yet,',
    'then ask one question at a time:',
    '1. "Who am I?" (IDENTITY) - a name if they want one, plus what kind of presence, tone, and values this agent should have. A name alone is enough only if that is all they offer.',
    '2. "What is my mission?" (MISSION) - what this agent exists to do for them.',
    'After the core answers, offer an advanced setup: RELATIONSHIP (how you should relate to each other) and REDLINE (hard boundaries the user sets).',
    'DREAM (aspirations and direction) and DARK (fears and shadow) are never questions for the user: in advanced setup, draft them yourself from the conversation and pass them in the same laputa_init call.',
    'Call laputa_init only after the user has answered explicitly. Preserve their words; never invent an identity or mission.',
    'laputa_init only fills missing or empty files and never overwrites content the user already wrote.',
    'If the user is busy or declines, help with their task first, mention the setup once, and do not repeat it in later turns.',
    'If laputa_init is unavailable, tell the user to edit the persona files directly.',
  ].join('\n')
}
