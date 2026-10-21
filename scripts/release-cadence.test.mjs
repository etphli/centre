import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { releaseCadence } from './release-cadence.mjs';

test('release cadence counts merged PRs across merge, squash and rebase history',async t => {
  const directory = mkdtempSync(join(tmpdir(),'centre-release-cadence-'));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  const git = args => execFileSync('git',args,{cwd:directory,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-b','main']);
  git(['config','user.email','qa@example.invalid']); git(['config','user.name','QA']);
  const commit = message => {git(['commit','--allow-empty','-m',message]); return git(['rev-parse','HEAD']);};
  const heads = [commit('Existing release')]; git(['tag','v0.1.8']);
  const pulls = new Map();
  const pull = (number,sha) => ({number,merge_commit_sha:sha,merged_at:'2026-10-21T00:00:00Z',base:{ref:'main',repo:{full_name:'test/centre'}}});
  for (const [index,strategy] of ['merge','squash','rebase','merge','squash'].entries()) {
    const branch = `feature-${index}`;
    git(['switch','-c',branch]);
    // A PR with multiple commits must still count once.
    commit('First change'); const feature = commit('Second change');
    git(['switch','main']);
    let sha;
    if (strategy === 'merge') {git(['merge','--no-ff',branch,'-m','Merge feature']); sha = git(['rev-parse','HEAD']);}
    else if (strategy === 'squash') {git(['merge','--squash',branch]); sha = commit('Squash feature');}
    else {
      commit('Direct main change'); git(['switch',branch]); git(['rebase','--force-rebase','main']);
      git(['switch','main']); git(['merge','--ff-only',branch]); sha = git(['rev-parse','HEAD']);
    }
    pulls.set(sha,[pull(index + 1,sha),pull(index + 1,sha)]);
    pulls.set(feature,pulls.get(feature) ?? [pull(index + 1,sha)]);
    heads.push(sha);
  }
  let baseline = 'v0.1.8';
  const request = async path => {
    if (path.endsWith('/releases/latest')) return baseline ? {tag_name:baseline} : null;
    const sha = /\/commits\/([^/]+)\/pulls/.exec(path)?.[1];
    assert.ok(sha,`Unexpected API request: ${path}`);
    return pulls.get(sha) ?? [];
  };
  const decide = head => releaseCadence({repository:'test/centre',head},{readGit:git,request});
  for (let count = 0;count <= 5;count++) {
    assert.deepEqual(await decide(heads[count]),{publish:count >= 4,count,baseline:'v0.1.8'});
  }
  const direct = commit('Direct push');
  pulls.set(direct,[
    {...pull(50,direct),merged_at:null},
    {...pull(51,direct),base:{ref:'other',repo:{full_name:'test/centre'}}},
    {...pull(52,direct),base:{ref:'main',repo:{full_name:'other/centre'}}},
  ]);
  assert.equal((await decide(direct)).count,5,'Direct pushes and unrelated PRs do not count.');
  git(['tag','v0.1.9',heads[4]]); baseline = 'v0.1.9';
  assert.deepEqual(await decide(direct),{publish:false,count:1,baseline:'v0.1.9'});
  assert.deepEqual(await decide(heads[3]),{publish:false,count:0,baseline:'v0.1.9'},'An older queued run cannot publish over a newer release.');
  baseline = null;
  assert.deepEqual(await decide(direct),{publish:true,count:5,baseline:null});
});

test('release cadence paginates commit PRs and fails on API errors',async () => {
  const readGit = () => 'merge-sha';
  const paths = [];
  const result = await releaseCadence({repository:'test/centre',head:'HEAD'},{readGit,request:async path => {
    paths.push(path);
    if (path.endsWith('/releases/latest')) return {tag_name:'v0.1.8'};
    if (path.endsWith('page=1')) return Array.from({length:100},(_,number) => ({number,merged_at:null}));
    return [{number:101,merged_at:'today',merge_commit_sha:'merge-sha',base:{ref:'main',repo:{full_name:'test/centre'}}}];
  }});
  assert.equal(result.count,1); assert.equal(paths.length,3);
  await assert.rejects(releaseCadence({repository:'test/centre',head:'HEAD'},{readGit,request:async () => {throw new Error('GitHub unavailable');}}),/GitHub unavailable/);
});
