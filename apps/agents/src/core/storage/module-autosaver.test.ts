import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleAutoSaver,loadWorkspaceModuleSnapshots } from './module-snapshots.ts'
import { workspaceModulePaths } from '../paths.ts'

test('a retry and concurrent flush persist the latest state', async () => {
  const root = await mkdtemp(join(tmpdir(),'audit-agents-save-'))
  const previous = process.env.LEITBILD_HOME
  process.env.LEITBILD_HOME = root
  const paths = workspaceModulePaths('d4106039-0b14-4e34-8f74-f051665bf8c6' as never)
  let prompt = 'old prompt'
  const runtime = {
    rooms:{listAllRooms:()=>[],getRoom:()=>undefined},team:{listAgents:()=>[]},
    bookmarks:{list:()=>[{id:'audit',content:'audit'}]},
    settings:{getPrompt:()=>prompt,getResponseFormat:()=>''},
  }
  const originalWrite = Bun.write
  let failFirst = true, failed!:()=>void
  const failureSeen = new Promise<void>(resolve=>{failed=resolve})
  Bun.write = (async (...args: Parameters<typeof Bun.write>) => {
    if(failFirst && String(args[0]).startsWith(root)) { failFirst=false;failed();throw new Error('injected transient disk failure') }
    return originalWrite(...args)
  }) as typeof Bun.write
  const saver = createModuleAutoSaver(runtime as never,paths,1)
  try {
    saver.scheduleSave()
    await failureSeen
    // Flush at once, while the failed save waits out its 250 ms retry backoff:
    // a sleep a loaded machine stretched past the backoff would let the retry
    // finish first and leave no concurrent flush to test.
    prompt='new prompt'
    await saver.flush()
    const afterFlush=(await loadWorkspaceModuleSnapshots(paths)).agents?.workspacePrompt
    await Bun.sleep(300)
    const afterRetry=(await loadWorkspaceModuleSnapshots(paths)).agents?.workspacePrompt
    expect(afterFlush).toBe('new prompt')
    expect(afterRetry).toBe('new prompt')
  } finally {
    await saver.dispose();Bun.write=originalWrite
    if(previous===undefined)delete process.env.LEITBILD_HOME;else process.env.LEITBILD_HOME=previous
    await rm(root,{recursive:true,force:true})
  }
},10000)
