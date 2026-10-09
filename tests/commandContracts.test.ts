import { expect, it } from 'vitest'
import { commandContracts } from './commandContracts'
import Ajv from 'ajv'
import { surfingCommandResults } from '../src/commandResults'

it('publishes distinct typed input and output contracts for every background action', () => {
  expect(commandContracts).toHaveLength(16)
  expect(new Set(commandContracts.map(entry => entry.command.id)).size).toBe(commandContracts.length)
  for (const entry of commandContracts) expect(entry.output({ unexpected: 'not an owner result' }), entry.command.id).toBe(false)
})

it('publishes strict renderer owner results including empty, false and zero values', () => {
  expect(Object.keys(surfingCommandResults)).toHaveLength(37)
  const compiler = new Ajv({ strict: true })
  for (const [id, schema] of Object.entries(surfingCommandResults)) {
    const validate = compiler.compile(schema)
    expect(validate({ unexpected: 'not an owner result' }), id).toBe(false)
  }
  expect(compiler.compile(surfingCommandResults['browser-snapshot'])({ url: '', title: '', count: 0, text: '', elements: [{ ref: 0, role: '', name: '', value: '', disabled: false, inViewport: false }] })).toBe(true)
  expect(compiler.compile(surfingCommandResults['list-saved-pages'])({ rows: [], revision: 0 })).toBe(true)
})
