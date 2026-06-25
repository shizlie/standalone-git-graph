import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";

export async function sync(git: SimpleGit, _input: ActionPayload<"sync">): Promise<void> {
  await git.raw(["pull"]);
  await git.raw(["push"]);
}
