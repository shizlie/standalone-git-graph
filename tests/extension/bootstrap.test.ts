import { describe, expect, it, vi } from "vitest";

import type { PanelHandle } from "@/extension/bootstrap";
import { viewGitGraphCommand } from "@/extension/bootstrap";

function makeFakePanel() {
  const reveal = vi.fn();
  const panel: PanelHandle = { reveal: reveal as unknown as PanelHandle["reveal"] };

  let onDisposeCallback: (() => void) | undefined;
  const factory = vi.fn((onDispose: () => void) => {
    onDisposeCallback = onDispose;
    return panel;
  });

  return {
    panel,
    reveal,
    factory,
    simulateDispose: () => onDisposeCallback?.()
  };
}

describe("viewGitGraphCommand", () => {
  it("creates a panel on first invocation", () => {
    const { factory } = makeFakePanel();
    const command = viewGitGraphCommand(factory);

    command();

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reveals the existing panel on second invocation", () => {
    const { factory, reveal } = makeFakePanel();
    const command = viewGitGraphCommand(factory);

    command();
    command();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("does not create a new panel while one is already open", () => {
    const { factory } = makeFakePanel();
    const command = viewGitGraphCommand(factory);

    command();
    command();
    command();

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("creates a new panel after the previous one is disposed", () => {
    const { factory, simulateDispose } = makeFakePanel();
    const command = viewGitGraphCommand(factory);

    command();
    simulateDispose();
    command();

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not reveal after dispose — creates a fresh panel instead", () => {
    const { factory, reveal, simulateDispose } = makeFakePanel();
    const command = viewGitGraphCommand(factory);

    command();
    simulateDispose();
    command();

    expect(reveal).not.toHaveBeenCalled();
  });

  it("passes an onDispose callback to the factory", () => {
    const { factory } = makeFakePanel();
    const command = viewGitGraphCommand(factory);

    command();

    expect(factory).toHaveBeenCalledWith(expect.any(Function));
  });

  it("clears the panel reference when onDispose is called", () => {
    const { factory, simulateDispose } = makeFakePanel();
    const command = viewGitGraphCommand(factory);

    command();
    simulateDispose();
    command();

    // After dispose, factory must be called again (panel reference was cleared)
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
