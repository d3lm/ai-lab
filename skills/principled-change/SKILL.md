---
name: principled-change
description: Makes bug fixes and feature changes with maintainable, first-principles design instead of bolted-on patches. Requires evidence. For bugs, that means a proven cause-and-effect chain, a failing test before the fix, a passing test after, and a revert check. For features, it means tests that define the behavior, fail first, pass after, and catch a deliberate break. Ends with a final report. Use when fixing a bug, investigating a regression, implementing a feature, or changing long-lived code.
disable-model-invocation: true
---

I care a lot about code quality and maintainability. Treat this as code that a team will own for years, not a quick patch. I will only trust the result if you can prove it works for the right reason.

## Understand before you change anything

- Read the surrounding code and work out how the current design is meant to work before you edit it.
- For a bug, find the root cause. If the bug shows up in module A but the wrong behavior starts in module B, fix it in B.
- For a feature, find where it belongs: the module that owns the data or invariant involved, not the first place that's convenient to hook in.
- Before writing a helper, look for an existing one, a pattern already used elsewhere, or a nearby abstraction that already does this.

## Work from first principles, don't bolt things on

- Ask what the correct model is: what each piece should own, and what invariants it should keep. Then make the code match that model.
- If the current design can't express the change cleanly, change the design. Don't work around it.
- Bolting on includes:
  - special-case `if` branches or flags added for one caller or one test
  - boolean or optional parameters that switch a function into a different mode
  - try/catch blocks that swallow errors, or fallbacks that hide a broken invariant
  - timeouts, retries, or reordering that paper over a race instead of fixing it
  - duplicating logic because sharing it looked like more work
  - patching the output of a function instead of fixing the function
- If the clean change needs a bigger refactor than the task seems to call for, say so and propose it. Don't quietly ship the hack.

## Get responsibility boundaries right

- Each module, class, or function owns one concern. Logic belongs in the layer that owns the data or the invariant involved.
- Callers depend on what a component does, not on how it does it. Don't reach into another module's internals or private state, and don't import across package boundaries through the back door.
- Keep dependencies pointing one way. Low-level code must not know about its high-level consumers.
- Keep interfaces small and explicit: clear names, precise types, and no leaked implementation details.
- If a change forces you to touch many unrelated places, treat that as a sign the boundary is in the wrong place.

## Keep it simple and consistent

- Don't add abstractions for hypothetical future needs. Add the right one for today's real need.
- Match the conventions, naming, and idioms of the surrounding code.
- Delete code your change makes dead or redundant. Leave the area at least as clean as you found it.
- Only write comments for constraints the code can't express itself.

## Prove it works for the right reason

### Before changing code

For a bug:

- State the root cause as a concrete chain of cause and effect, from the trigger to the visible symptom, with file and line references. "X is sometimes wrong" is not a root cause. "A calls B before C has set D, so B reads a stale value" is.
- Back each link in that chain with evidence: a log line, a debugger observation, a minimal repro, or the code path itself. If a link is a guess, label it as a guess.
- Write a failing test or repro and run it. Show the actual output and confirm it fails for the reason you stated, not just that it fails.

For a feature:

- State the required behavior concretely: inputs, outputs, error cases, and any invariant it adds. If the request is ambiguous, ask instead of guessing.
- Name the module that will own the behavior, and say why it's the right owner.
- Write tests at that layer that specify the behavior. Run them and show they fail because the behavior is missing, not because of a setup, import, or compile error.

For both: when a reference implementation exists (for example, upstream behavior or a spec), show what it does and confirm the change matches it.

### After changing code

- Run the same tests and show they now pass.
- For a bug, revert or disable only the fix, show the test fails again, then restore the fix. This proves the test exercises the fix.
- For a feature, break the core logic on purpose (for example, flip a condition or return early), show at least one test fails, then restore it. This proves the tests aren't vacuous.
- Name the invariant that now holds and where it is enforced. For a bug, explain why the fix removes the cause rather than masking it.
- For a bug, find other code paths that share the same root cause. Show they are fixed too, or explain why they don't apply. Add at least one test case that a symptom-only fix would miss, such as a different caller, input, or timing.
- For a feature, cover edge cases, error paths, and at least one caller or input beyond the main one.
- Test the behavior at the layer that owns it, not only through some distant integration path. Tests should pin down the invariant, not implementation details.
- Run the wider relevant test suite and report the results, so there's evidence nothing regressed.

### Evidence rules

- Show real command output. Don't paraphrase it, and don't claim a test passes unless you ran it.
- Keep what you verified separate from what you inferred. If you couldn't run something, say so and explain why.
- If the evidence doesn't fully support your story, say that plainly instead of declaring success.

## When you finish, report

- For a bug, the root cause chain and the evidence for each link. For a feature, the required behavior and the invariants it adds.
- The proof: tests failing before the change and passing after it, failing again under the revert (bug) or the deliberate break (feature), and the wider test suite results.
- Where the logic now lives and why that is the right owner.
- Which alternatives you considered and rejected, and what you removed or simplified.
- Anything still unverified, plus any remaining design debt or follow-up refactor worth doing.
