// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import example from "../../../shared/examples/building.json";
import { parseProject, serializeProject } from "./projectFile";
import type { FurnitureKind } from "./furniture";
import type { TracingReference } from "./tracing";
import { useProjectFiles } from "./useProjectFiles";

let root: Root,
  host: HTMLDivElement,
  controls: ReturnType<typeof useProjectFiles>;
const onOpen = vi.fn(() => true),
  onSaved = vi.fn(),
  onError = vi.fn(),
  onNotice = vi.fn();
const releaseImage = vi.fn();
const image: TracingReference = {
  asset: {
    id: "image",
    name: "plan.png",
    blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])]),
    image: {} as HTMLImageElement,
    url: "blob:image",
    width: 10,
    height: 10,
  },
  config: {
    width: 10,
    x: 0,
    y: 0,
    opacity: 0.3,
    visible: true,
    sizing: "fitted",
  },
};
const loadImage = vi.fn(async () => image.asset);
function options() {
  return {
    building: structuredClone(example),
    reference: null as TracingReference | null,
    furniture: new Map<string, FurnitureKind>(),
    disabled: false,
    referenceProblem: null as string | null,
    loadImage,
    releaseImage,
    onOpen,
    onSaved,
    onError,
    onNotice,
  };
}
let props: ReturnType<typeof options>;
function Harness() {
  controls = useProjectFiles(props);
  return <input type="file" ref={controls.input} />;
}
async function render() {
  await act(async () => root.render(<Harness />));
}
async function projectFile(withImage = false) {
  const text = await serializeProject(
    example,
    withImage ? image : null,
    new Map(),
  );
  return new File([text], "plan.exitzero");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  onOpen.mockReturnValue(true);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = options();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("downloads the full current document and marks it saved only after download starts", async () => {
  await render();
  await act(async () => controls.save());
  expect(onSaved).toHaveBeenCalledOnce();
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
  expect(
    (await parseProject({ size: blob.size, text: () => blob.text() })).building,
  ).toEqual(example);
  expect(controls.busy).toBe(false);
});
it("keeps current state intact on invalid input and permits trying another file", async () => {
  await render();
  await act(async () => controls.open(new File(["{"], "bad.exitzero")));
  expect(onOpen).not.toHaveBeenCalled();
  expect(onError).toHaveBeenLastCalledWith(
    expect.stringMatching(/not a valid/),
  );
  const file = await projectFile();
  await act(async () => controls.open(file));
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ building: example }),
    null,
  );
});
it("decodes images before applying and releases temporary images if the user cancels", async () => {
  onOpen.mockReturnValue(false);
  await render();
  const file = await projectFile(true);
  await act(async () => controls.open(file));
  expect(loadImage).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ building: example }),
    image,
  );
  expect(releaseImage).toHaveBeenCalledWith(image.asset);
  expect(onNotice).toHaveBeenLastCalledWith("");
});
it("does not adopt a decoded image if its physical bounds are invalid", async () => {
  loadImage.mockResolvedValueOnce({ ...image.asset, width: 1, height: 1000 });
  await render();
  const file = await projectFile(true);
  await act(async () => controls.open(file));
  expect(onOpen).not.toHaveBeenCalled();
  expect(releaseImage).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenLastCalledWith(
    expect.stringMatching(/1,000|1000|drawing/),
  );
});
it("aborts a pending open if the user edits the current document", async () => {
  let finish!: (text: string) => void;
  const text = await serializeProject(example, null, new Map());
  const file = {
    size: text.length,
    text: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  } as File;
  await render();
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.open(file);
  });
  expect(controls.busy).toBe(true);
  props = { ...props, building: { ...props.building, seed: 123 } };
  await render();
  await act(async () => {
    finish(text);
    await pending;
  });
  expect(onOpen).not.toHaveBeenCalled();
  expect(onError).toHaveBeenLastCalledWith(
    expect.stringMatching(/changed while opening/),
  );
});
it("rejects incomplete reference restoration rather than downloading an incomplete project", async () => {
  props.referenceProblem = "Reference is still loading";
  await render();
  await act(async () => controls.save());
  expect(onSaved).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(onError).toHaveBeenLastCalledWith("Reference is still loading");
});
it("does not download a stale snapshot if the document changes while preparing its image", async () => {
  props.reference = image;
  let finish!: (bytes: ArrayBuffer) => void;
  const bytes = await image.asset.blob.arrayBuffer();
  vi.spyOn(image.asset.blob, "arrayBuffer").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.save();
  });
  props = { ...props, building: { ...props.building, seed: 123 } };
  await render();
  await act(async () => {
    finish(bytes);
    await pending;
  });
  expect(onSaved).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(onError).toHaveBeenLastCalledWith(
    expect.stringMatching(/changed while saving/),
  );
});
it("cannot replace the drawing after the editor unmounts during file reading", async () => {
  let finish!: (text: string) => void;
  const text = await serializeProject(example, null, new Map());
  const file = {
    size: text.length,
    text: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  } as File;
  await render();
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.open(file);
  });
  await act(async () => root.render(null));
  await act(async () => {
    finish(text);
    await pending;
  });
  expect(onOpen).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
});
it("cleans failed downloads and does not claim a save", async () => {
  vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(() => {
    throw new Error("Download failed");
  });
  await render();
  await act(async () => controls.save());
  expect(onSaved).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  expect(onError).toHaveBeenLastCalledWith("Download failed");
});
it("ignores file actions while disabled", async () => {
  props.disabled = true;
  await render();
  const file = await projectFile();
  await act(async () => {
    void controls.save();
    void controls.open(file);
  });
  expect(onOpen).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});
