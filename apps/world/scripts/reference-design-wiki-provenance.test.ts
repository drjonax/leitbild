import {expect,test} from 'bun:test'
import {chmod,cp,mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gitTreeHash,wikiProvenance} from './reference-design-wiki-provenance'
import {waterToolchain} from './reference-design-operating-water'

const git=(cwd:string,...args:string[])=>{
  const run=Bun.spawnSync(['git','-c','user.name=test','-c','user.email=test@example.invalid',
    '-c','commit.gpgsign=false','-c','core.autocrlf=false',...args],{cwd,stdout:'pipe',stderr:'pipe'})
  if(run.exitCode!==0)throw Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

// A test-only directory with every kind of git content; not wiki text.
async function sample(root:string){
  await mkdir(join(root,'world/packs/x'),{recursive:true})
  await mkdir(join(root,'empty'),{recursive:true})
  await writeFile(join(root,'index.md'),'# Index\n')
  await writeFile(join(root,'world/packs/x/page.md'),'```ld01-block\n{"a":1}\n```\n')
  await writeFile(join(root,'world/a-b.md'),'sorted before the a directory\n')
  await mkdir(join(root,'world/a'),{recursive:true})
  await writeFile(join(root,'world/a/z.md'),'z\n')
  await writeFile(join(root,'tool.sh'),'#!/bin/sh\n')
  await chmod(join(root,'tool.sh'),0o755)
  await symlink('index.md',join(root,'link.md'))
}

test('the tree hash is git\'s own for files, modes, links, nesting and name order',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'wiki-provenance-'))
  try{
    const root=join(temporary,'wiki')
    await sample(root)
    git(temporary,'init','-q','wiki')
    git(root,'add','-A')
    expect(await gitTreeHash(root)).toBe(git(root,'write-tree'))
    await rm(join(root,'empty'),{recursive:true})
    await writeFile(join(root,'index.md'),'# Changed\n')
    expect(await gitTreeHash(root)).not.toBe(git(root,'write-tree'))
  }finally{await rm(temporary,{recursive:true,force:true})}
})

test('a named commit is accepted only when its tree is the directory read',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'wiki-provenance-'))
  try{
    const repository=join(temporary,'repository'),archive=join(temporary,'archive')
    await sample(repository)
    git(temporary,'init','-q','repository')
    git(repository,'add','-A')
    git(repository,'commit','-q','-m','first')
    const first=git(repository,'rev-parse','HEAD')
    await cp(repository,archive,{recursive:true,verbatimSymlinks:true})
    await rm(join(archive,'.git'),{recursive:true})
    await writeFile(join(repository,'index.md'),'# Second\n')
    git(repository,'commit','-q','-am','second')
    const second=git(repository,'rev-parse','HEAD')
    const verified=await wikiProvenance(archive,{LD01_WIKI_COMMIT:first.slice(0,7),LD01_WIKI_REPOSITORY:repository})
    expect(verified.commit).toBe(first)
    expect(verified.basis).toBe('LD01_WIKI_COMMIT verified against the tree')
    expect(wikiProvenance(archive,{LD01_WIKI_COMMIT:second,LD01_WIKI_REPOSITORY:repository})).rejects.toThrow('has tree')
    expect(wikiProvenance(archive,{LD01_WIKI_COMMIT:first})).rejects.toThrow('LD01_WIKI_REPOSITORY')
    expect(await wikiProvenance(archive,{})).toEqual({root:archive,tree:verified.tree,commit:null,
      basis:'no commit named: the tree identifies the content'})
    expect((await wikiProvenance(repository,{})).basis).toBe('checkout HEAD, files match its tree')
    await writeFile(join(repository,'index.md'),'# Dirty\n')
    const dirty=await wikiProvenance(repository,{})
    expect([dirty.commit,dirty.basis]).toEqual([second,'checkout HEAD, files differ from its tree'])
  }finally{await rm(temporary,{recursive:true,force:true})}
})

test('the water build pins its compiler and archives deterministically on each platform',()=>{
  const darwin=waterToolchain('darwin'),linux=waterToolchain('linux')
  expect(darwin.archiver).toBe('libtool -static -D (ZERO_AR_DATE=1)')
  expect(linux.archiver).toBe('ar rcsD')
  expect(linux.compiler.version.length).toBeGreaterThan(0)
  expect(linux.compiler.flags).toEqual(['-std=c++17','-O2','-fPIC'])
})
