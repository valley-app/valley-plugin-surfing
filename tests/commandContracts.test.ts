import { expect, it } from 'vitest'
import { commandContracts } from './commandContracts'

it('publishes distinct typed input and output contracts for every background action', () => {
  expect(commandContracts).toHaveLength(15)
  expect(new Set(commandContracts.map(entry => entry.command.id)).size).toBe(commandContracts.length)
  for (const entry of commandContracts) expect(entry.output({ unexpected: 'not an owner result' }), entry.command.id).toBe(false)
})
