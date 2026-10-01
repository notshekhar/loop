import { describe, expect, it, vi } from "vite-plus/test";
import type { AtomCommandResult } from "@loop/runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { FileSaveCoordinator } from "./fileSaveCoordinator";

function deferred() {
  let resolve!: (result: AtomCommandResult<void, never>) => void;
  const promise = new Promise<AtomCommandResult<void, never>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const succeeds = () =>
  vi
    .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
    .mockResolvedValue(AsyncResult.success(undefined));

describe("FileSaveCoordinator", () => {
  /**
   * The whole point of the change: typing is not a commitment. A debounce
   * timer used to write half a second after you stopped, so there was no
   * moment where a half-finished edit was only yours.
   */
  it("does not write on its own, however long it waits", async () => {
    const persist = succeeds();
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    coordinator.change("latest");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(persist).not.toHaveBeenCalled();
    expect(coordinator.pending).toBe(true);
    expect(onPendingChange.mock.calls).toEqual([[true], [true]]);
  });

  it("writes the latest contents once, when asked", async () => {
    const persist = succeeds();
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({ persist, onPendingChange, onConfirmed });

    coordinator.change("first");
    coordinator.change("latest");
    expect(await coordinator.save()).toBe(true);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
    expect(onConfirmed).toHaveBeenCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
    expect(coordinator.pending).toBe(false);
  });

  it("saving an unchanged file does not touch the disk", async () => {
    const persist = succeeds();
    const coordinator = new FileSaveCoordinator({
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    // Nothing typed yet.
    expect(await coordinator.save()).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    coordinator.change("edited");
    await coordinator.save();
    // Twice on the shortcut is still one write.
    await coordinator.save();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("stays pending when the write fails", async () => {
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      persist: vi.fn().mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write failed")))),
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    expect(await coordinator.save()).toBe(false);
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
    expect(coordinator.pending).toBe(true);
  });

  /**
   * An edit landing mid-write must not be left on the floor: the file would
   * read as saved while the disk held the older text.
   */
  it("picks up an edit made while a write was in flight", async () => {
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    const saving = coordinator.save();
    coordinator.change("latest");
    firstWrite.resolve(AsyncResult.success(undefined));
    await saving;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
    expect(coordinator.pending).toBe(false);
  });

  /** A second shortcut press during a write folds in rather than racing it. */
  it("does not start a second concurrent write", async () => {
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("one");
    const first = coordinator.save();
    void coordinator.save();
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve(AsyncResult.success(undefined));
    await first;
    expect(persist).toHaveBeenCalledTimes(1);
  });

  /**
   * Closing a pane is not a decision to save. The text is kept by the panel's
   * optimistic cache, and the file stays marked unsaved.
   */
  it("writes nothing when the pane goes away", async () => {
    const persist = succeeds();
    const coordinator = new FileSaveCoordinator({
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(persist).not.toHaveBeenCalled();
    expect(coordinator.pending).toBe(true);
  });
});
