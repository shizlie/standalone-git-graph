import type { SimpleGit } from "simple-git";

import type { ActionPayload } from "@/backend/types";

export async function pull(git: SimpleGit, _input: ActionPayload<"pull">): Promise<void> {
  await git.raw(["pull"]);
}
