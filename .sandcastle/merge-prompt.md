# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run the checks below to verify everything works
4. If tests fail, fix the issues before proceeding to the next branch

{{WORKSPACE_HINT}}

After all branches are merged, make a single commit summarizing the merge.

{{DEP_UPDATE_BLOCK}}

# CLOSE ISSUES

For each branch that was merged, mark its issue done using the following command:

{{CLOSE_CMD}}

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
