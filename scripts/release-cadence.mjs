import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pullRequestsPerRelease = 4;
const git = args => execFileSync('git',args,{encoding:'utf8'}).trim();

async function github(path) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/${path}`,{
    headers:{
      Accept:'application/vnd.github+json',
      Authorization:`Bearer ${process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version':'2022-11-28',
    },
  });
  if (response.status === 404 && path.endsWith('/releases/latest')) return null;
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${response.statusText}`);
  return response.json();
}

export async function releaseCadence({repository,head},{readGit = git,request = github} = {}) {
  const latest = await request(`repos/${repository}/releases/latest`);
  const range = latest ? `${latest.tag_name}..${head}` : head;
  const history = readGit(['rev-list','--first-parent',range]);
  const merged = new Set();
  for (const sha of history.split('\n').filter(Boolean)) {
    // First-parent history includes merge commits, squash commits and rebased PRs.
    // Match the final merge SHA so direct pushes and unrelated PRs do not count.
    for (let page = 1;;page++) {
      const pulls = await request(`repos/${repository}/commits/${sha}/pulls?per_page=100&page=${page}`);
      for (const pull of pulls) {
        if (pull.merged_at && pull.merge_commit_sha === sha && pull.base.ref === 'main' && pull.base.repo.full_name === repository) merged.add(pull.number);
      }
      if (pulls.length < 100) break;
    }
  }
  return {publish:merged.size >= pullRequestsPerRelease,count:merged.size,baseline:latest?.tag_name ?? null};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await releaseCadence({repository:process.env.GITHUB_REPOSITORY,head:process.env.GITHUB_SHA});
  const summary = `${result.count}/${pullRequestsPerRelease} merged PRs since ${result.baseline ?? 'the start of the repository'}. ${result.publish ? 'Release due.' : 'Waiting for the next batch.'}`;
  console.log(summary);
  appendFileSync(process.env.GITHUB_OUTPUT,`publish=${result.publish}\ncount=${result.count}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,`${summary}\n`);
}
