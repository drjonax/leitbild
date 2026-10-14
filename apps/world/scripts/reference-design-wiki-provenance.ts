/** Wiki provenance of an LD-01 build input or receipt: the git tree hash of
 * the wiki directory actually read, and the commit it is verified to be.
 *
 * Receipts are composed from `git archive` extractions, which carry no
 * commit. The tree hash identifies their content exactly; a commit named by
 * LD01_WIKI_COMMIT is accepted only when its tree, resolved in the wiki
 * repository named by LD01_WIKI_REPOSITORY (or the root itself when it is a
 * checkout), equals that hash. A checkout without LD01_WIKI_COMMIT is its
 * HEAD, and the receipt says whether its files match HEAD's tree. */
import {createHash} from 'node:crypto'
import {lstat, readdir, readFile, readlink} from 'node:fs/promises'
import {join, resolve} from 'node:path'

const objectId=(type:'blob'|'tree',content:Buffer)=>createHash('sha1')
  .update(Buffer.concat([Buffer.from(`${type} ${content.length}\0`),content])).digest()

/** Git's tree id of `directory` as git would store its files: regular files
 * 100644 or 100755 (owner execute bit), symbolic links 120000, directories
 * as trees; `.git` and empty directories are not content. No filters or
 * line-ending conversion apply (the wiki declares none). */
export async function gitTreeHash(directory:string):Promise<string>{
  const tree=async(path:string):Promise<Buffer|null>=>{
    const entries=[]
    for(const entry of await readdir(path,{withFileTypes:true})){
      if(entry.name==='.git')continue
      const full=join(path,entry.name)
      if(entry.isDirectory()){
        const id=await tree(full)
        if(id)entries.push({mode:'40000',name:entry.name,sortKey:entry.name+'/',id})
      }else if(entry.isSymbolicLink()){
        entries.push({mode:'120000',name:entry.name,sortKey:entry.name,id:objectId('blob',Buffer.from(await readlink(full)))})
      }else if(entry.isFile()){
        const executable=((await lstat(full)).mode&0o100)!==0
        entries.push({mode:executable?'100755':'100644',name:entry.name,sortKey:entry.name,id:objectId('blob',await readFile(full))})
      }else throw Error(`Not git content: ${full}`)
    }
    if(!entries.length)return null
    entries.sort((a,b)=>Buffer.compare(Buffer.from(a.sortKey),Buffer.from(b.sortKey)))
    return objectId('tree',Buffer.concat(entries.map(e=>Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`),e.id]))))
  }
  const id=await tree(resolve(directory))
  if(!id)throw Error(`Empty wiki directory: ${directory}`)
  return id.toString('hex')
}

function git(repository:string,...args:string[]){
  const run=Bun.spawnSync(['git','-C',repository,...args],{stdout:'pipe',stderr:'pipe'})
  if(run.exitCode!==0)throw Error(`git ${args.join(' ')} in ${repository}: ${run.stderr.toString().trim()}`)
  return run.stdout.toString().trim()
}

export type WikiProvenance={root:string,tree:string,commit:string|null,
  /** How the commit was established, or why there is none. */
  basis:'LD01_WIKI_COMMIT verified against the tree'|'checkout HEAD, files match its tree'|
    'checkout HEAD, files differ from its tree'|'no commit named: the tree identifies the content'}

/** Provenance of the wiki directory `root` under the given environment. */
export async function wikiProvenance(root:string,
  env:Readonly<Record<string,string|undefined>>=Bun.env):Promise<WikiProvenance>{
  const directory=resolve(root),tree=await gitTreeHash(directory)
  const checkout=await lstat(join(directory,'.git')).then(()=>true,()=>false)
  const named=env['LD01_WIKI_COMMIT']
  if(named){
    const repository=env['LD01_WIKI_REPOSITORY']??(checkout?directory:undefined)
    if(!repository)throw Error('LD01_WIKI_COMMIT needs LD01_WIKI_REPOSITORY (the wiki git repository) to verify it')
    const commit=git(repository,'rev-parse','--verify',`${named}^{commit}`)
    const committed=git(repository,'rev-parse','--verify',`${commit}^{tree}`)
    if(committed!==tree)
      throw Error(`LD01_WIKI_COMMIT ${named} has tree ${committed}, but ${directory} is tree ${tree}`)
    return {root:directory,tree,commit,basis:'LD01_WIKI_COMMIT verified against the tree'}
  }
  if(checkout){
    const commit=git(directory,'rev-parse','--verify','HEAD^{commit}')
    const clean=git(directory,'rev-parse','--verify',`${commit}^{tree}`)===tree
    return {root:directory,tree,commit,basis:clean?'checkout HEAD, files match its tree':'checkout HEAD, files differ from its tree'}
  }
  return {root:directory,tree,commit:null,basis:'no commit named: the tree identifies the content'}
}

if(import.meta.main){
  const [root,...rest]=Bun.argv.slice(2)
  if(!root||rest.length)throw Error('Usage: wiki-provenance <wiki root> (LD01_WIKI_COMMIT, LD01_WIKI_REPOSITORY)')
  console.log(JSON.stringify(await wikiProvenance(root)))
}
