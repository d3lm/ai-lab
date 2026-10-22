import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../src";

type Events = { save: string; close: undefined };

describe("Emitter", () => {
  it("calls listeners with the payload", () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    e.on("save", fn);
    e.emit("save", "doc1");
    expect(fn).toHaveBeenCalledWith("doc1");
  });

  it("does not call a listener after it is removed", () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    const off = e.on("save", fn);
    off();
    e.emit("close", undefined);
    expect(fn).not.toHaveBeenCalled();
  });

  it("once listeners fire once", () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    e.once("save", fn);
    e.emit("save", "a");
    expect(fn).toHaveBeenCalled();
  });
});
