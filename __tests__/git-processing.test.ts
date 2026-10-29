import { Octokit } from '@octokit/rest'
import { gitProcessing } from '../src/action'
import { EmptyActions } from '../src/github-actions'
import { ChangedFile } from '../src/types'

type FakeRepo = {
  head: string
  // Paths changed by commits that land on the branch while we try to update it
  concurrentChanges: string[][]
  updateRefCalls: string[]
  createRefCalls: number
}

const nonFastForward = (): Error =>
  Object.assign(new Error('Update is not a fast forward'), { status: 422 })

const fakeOctokit = (repo: FakeRepo): Octokit => {
  let commits = 0
  const changedSince: { [commit: string]: string[] } = {}

  return {
    git: {
      getRef: async () => ({ data: { object: { sha: repo.head } } }),
      getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
        data: { tree: { sha: `tree-${commit_sha}` } }
      }),
      createBlob: async () => ({ data: { sha: 'blob' } }),
      createTree: async ({ base_tree }: { base_tree: string }) => ({
        data: { sha: `new-${base_tree}` }
      }),
      createCommit: async () => ({ data: { sha: `commit-${++commits}` } }),
      updateRef: async ({ sha }: { sha: string }) => {
        repo.updateRefCalls.push(sha)

        const concurrent = repo.concurrentChanges.shift()
        if (concurrent) {
          const previous = repo.head
          repo.head = `${previous}-moved`
          changedSince[repo.head] = [
            ...(changedSince[previous] || []),
            ...concurrent
          ]
          throw nonFastForward()
        }

        repo.head = sha
        return { data: {} }
      },
      createRef: async () => {
        repo.createRefCalls++
        return { data: {} }
      }
    },
    repos: {
      compareCommits: async ({ head }: { head: string }) => ({
        data: {
          files: (changedSince[head] || []).map(filename => ({ filename }))
        }
      })
    }
  } as unknown as Octokit
}

const files = (): ChangedFile[] => [
  {
    absolutePath: '/work/apps/a/values.yaml',
    relativePath: 'apps/a/values.yaml',
    content: 'version: v2',
    json: {}
  }
]

const run = async (repo: FakeRepo, retries: number): Promise<void> =>
  gitProcessing(
    'owner/repo',
    'main',
    false,
    'master',
    files(),
    'update',
    fakeOctokit(repo),
    new EmptyActions(),
    { name: 'bot', email: 'bot@example.com' },
    retries,
    async () => {}
  )

const newRepo = (concurrentChanges: string[][] = []): FakeRepo => ({
  head: 'base',
  concurrentChanges,
  updateRefCalls: [],
  createRefCalls: 0
})

test('commits without retrying when the branch did not move', async () => {
  const repo = newRepo()

  await run(repo, 3)

  expect(repo.updateRefCalls).toHaveLength(1)
  expect(repo.head).toBe('commit-1')
})

test('rebuilds the commit on the new head when the branch moved', async () => {
  const repo = newRepo([['apps/b/values.yaml']])

  await run(repo, 3)

  expect(repo.updateRefCalls).toEqual(['commit-1', 'commit-2'])
  expect(repo.head).toBe('commit-2')
  expect(repo.createRefCalls).toBe(0)
})

test('fails after all retries when the branch keeps moving', async () => {
  const repo = newRepo([
    ['apps/b/values.yaml'],
    ['apps/c/values.yaml'],
    ['apps/d/values.yaml']
  ])

  await expect(run(repo, 2)).rejects.toThrow('not a fast forward')
  expect(repo.updateRefCalls).toHaveLength(3)
  expect(repo.createRefCalls).toBe(0)
})

test('does not retry when retries is 0', async () => {
  const repo = newRepo([['apps/b/values.yaml']])

  await expect(run(repo, 0)).rejects.toThrow('not a fast forward')
  expect(repo.updateRefCalls).toHaveLength(1)
})

test('does not overwrite concurrent changes to the same file', async () => {
  const repo = newRepo([['apps/a/values.yaml']])

  await expect(run(repo, 3)).rejects.toThrow(
    'updated concurrently with changes to apps/a/values.yaml'
  )
  expect(repo.updateRefCalls).toHaveLength(1)
})

test('still creates the branch when it does not exist yet', async () => {
  const repo = newRepo()
  const octokit = fakeOctokit(repo)
  octokit.git.updateRef = (async () => {
    throw Object.assign(new Error('Reference does not exist'), { status: 422 })
  }) as unknown as typeof octokit.git.updateRef

  await gitProcessing(
    'owner/repo',
    'feature',
    false,
    'master',
    files(),
    'update',
    octokit,
    new EmptyActions(),
    { name: 'bot', email: 'bot@example.com' },
    3,
    async () => {}
  )

  expect(repo.createRefCalls).toBe(1)
})
