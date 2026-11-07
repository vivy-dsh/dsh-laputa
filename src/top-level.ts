/**
 * Top-level agent detection shared by prompt injection and the setup tool.
 * @module dsh-laputa
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** Whether an agent is a top-level session rather than a delegated child. */
export function isTopLevelAgent(agent: Pick<Agent, 'session'>): boolean {
  const header = agent.session.header
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}
