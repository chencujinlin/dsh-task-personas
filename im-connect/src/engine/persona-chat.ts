/** Durable protocol marker, supplied by the optional persona plugin, never by a user message. */
export const PERSONA_CHAT_PROTOCOL = '【飞书人格聊天工具协议 v1】'
export function personaProtocolUpdate(event: { type?: string; data?: any }): boolean | undefined {
  if (event.type !== 'system/message') return undefined
  if (!(event.data?.message?.content ?? []).some((b: any) => b.type === 'text' && b.text)) return undefined
  return (event.data?.message?.content ?? []).some((b: any) => b.type === 'text' && typeof b.text === 'string' && b.text.includes(PERSONA_CHAT_PROTOCOL))
}
/** Read the effective durable surface after resume, including replaced prompt nodes. */
export function personaProtocolFromSession(session: any): boolean | undefined {
  if (!session?.surface?.nodes || typeof session.eventAt !== 'function') return undefined
  let mode = false
  for (const seq of session.surface.nodes) {
    const update = personaProtocolUpdate(session.eventAt(seq) ?? {})
    if (update !== undefined) mode = update
  }
  return mode
}
export function personaProtocolFromEvents(events: readonly { type?: string; data?: any }[]): boolean {
  let enabled = false
  for (const event of events) { const next = personaProtocolUpdate(event); if (next !== undefined) enabled = next }
  return enabled
}
