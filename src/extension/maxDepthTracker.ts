import { config } from "@/config";

let maxDepth = config.maxDepthOfRepoSearch();

export function maxDepthIncreased(): boolean {
  const prev = maxDepth;
  maxDepth = config.maxDepthOfRepoSearch();
  return maxDepth > prev;
}
